/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    addressSlackUsers,
    guid,
    MessageOptions,
} from "@atomist/automation-client";
import { Destination } from "@atomist/automation-client/lib/spi/message/MessageClient";
import {
    actionableButton,
    CommandHandlerRegistration,
    ExtensionPack,
    fetchGoalsForCommit,
    GoalCompletionListener,
    GoalCompletionListenerInvocation,
    metadata,
    SdmContext,
    SdmGoalEvent,
    SdmGoalState,
    slackErrorMessage,
    slackFooter,
    slackInfoMessage,
} from "@atomist/sdm";
import {
    bold,
    channel,
    codeLine,
    italic,
    SlackMessage,
    url,
} from "@atomist/slack-messages";
import * as _ from "lodash";
import { CoreRepoFieldsAndChannels } from "../../typings/types";
import { toArray } from "../../util/misc/array";
import { updateGoalStateCommand } from "../goal-state/updateGoal";

/**
 * Factory to create message destinations for goal notifications
 */
export type DestinationFactory = (goal: SdmGoalEvent, context: SdmContext) => Promise<Destination | Destination[] | undefined>;

/**
 * Factory to create notification messages
 */
export type NotificationFactory = (gi: GoalCompletionListenerInvocation) => Promise<{ message: any, options: MessageOptions }>;

/**
 * Options to configure the notification support
 */
export interface NotificationOptions {
    destination?: DestinationFactory | DestinationFactory[];
    notification?: NotificationFactory;
}

/**
 * Extension pack to send notifications on certain conditions.
 * Recipients and notification messages can be customized by providing options
 * with DestinationFactory and NotificationFactory.
 * @param options
 */
export function notificationSupport(options: NotificationOptions = {}): ExtensionPack {
    return {
        ...metadata("notification"),
        configure: sdm => {

            const updateGoalCommand = updateGoalStateCommand();
            updateGoalCommand.name = `${updateGoalCommand.name}ForNotifications`;
            sdm.addCommand(updateGoalCommand);

            const optsToUse: NotificationOptions = {
                destination: defaultDestinationFactory,
                notification: defaultNotificationFactory(updateGoalCommand),
                ...options,
            };

            sdm.addGoalCompletionListener(notifyGoalCompletionListener(optsToUse));
        },
    };
}

/**
 * Default DestinationFactory that would send every commit author a direct message in Slack / MS Teams.
 */
export async function defaultDestinationFactory(goal: SdmGoalEvent): Promise<Destination | Destination[] | undefined> {
    if (goal.state === SdmGoalState.failure) {

        return _.uniqBy(goal.push.commits.map(c => _.get(c, "author.person.chatId"))
            .filter(c => !!c), r => `${r.chatTeam.id}.${r.screenName}`)
            .map(r => addressSlackUsers(r.chatTeam.id, r.screenName));

    }

    return undefined;
}

/**
 * Default NotificationFactory that sends messages with restart, start and approve buttons where appropriate.
 */
export function defaultNotificationFactory(updateGoalCommand: CommandHandlerRegistration): NotificationFactory {
    return async gi => {
        const { completedGoal, context, id } = gi;
        const goals = await fetchGoalsForCommit(context, id, completedGoal.repo.providerId, completedGoal.goalSetId);
        const goalId = (goals.find(g => g.uniqueName === completedGoal.uniqueName) as any).id;
        const msgId = guid();

        let state: string;
        let suffix: string;
        let msg: SlackMessage;
        switch (completedGoal.state) {
            case SdmGoalState.failure:
                state = "has failed";
                suffix = "Failed";
                msg = slackErrorMessage("", "", context, {
                    actions: completedGoal.retryFeasible ? [
                        actionableButton({ text: "Restart" }, updateGoalCommand, {
                            id: goalId,
                            msgId,
                            state: SdmGoalState.requested,
                        })] : [],
                });
                break;
            case SdmGoalState.waiting_for_approval:
                state = "is waiting for approval";
                suffix = "Awaiting Approval";
                msg = slackInfoMessage("", "", {
                    actions: [actionableButton({ text: "Approve" }, updateGoalCommand, {
                        id: goalId,
                        msgId,
                        state: SdmGoalState.approved,
                    })],
                });
                break;
            case SdmGoalState.waiting_for_pre_approval:
                state = "is waiting to start";
                suffix = "Awaiting Start";
                msg = slackInfoMessage("", "", {
                    actions: [actionableButton({ text: "Start" }, updateGoalCommand, {
                        id: goalId,
                        msgId,
                        state: SdmGoalState.pre_approved,
                    })],
                });
                break;
            case SdmGoalState.stopped:
                state = "has stopped";
                suffix = "Stopped";
                msg = slackInfoMessage("", "");
                break;
            default:
                return;
        }

        const author = `Goal ${suffix}`;
        const text = `Goal ${italic(completedGoal.url ? url(completedGoal.url, completedGoal.name) : completedGoal.name)} on ${
            url(completedGoal.push.after.url, codeLine(completedGoal.sha.slice(0, 7)))} ${italic(completedGoal.push.after.message)} of ${
            bold(`${url(completedGoal.push.repo.url, `${completedGoal.repo.owner}/${completedGoal.repo.name}/${
                completedGoal.branch}`)}`)} ${state}.`;
        const channels: CoreRepoFieldsAndChannels.Channels[] = _.get(completedGoal, "push.repo.channels") || [];
        const channelLink = channels.filter(c => !!c.channelId).map(c => channel(c.channelId)).join(" \u00B7 ");
        const link =
            `https://app.atomist.com/workspace/${context.workspaceId}/goalset/${completedGoal.goalSetId}`;

        msg.attachments[0] = {
            ...msg.attachments[0],
            author_name: author,
            text,
            footer: `${slackFooter()} \u00B7 ${url(link, completedGoal.goalSetId.slice(0, 7))} \u00B7 ${channelLink}`,
        };

        return { message: msg, options: { id: msgId } };
    };
}

/**
 * GoalCompletionListener that delegates to the NotificationFactory and DestinationFactory to
 * create notifications and send them out.
 */
export function notifyGoalCompletionListener(options: NotificationOptions): GoalCompletionListener {
    return async gi => {
        const { completedGoal, context } = gi;

        const destinations: Destination[] = [];

        for (const destinationFactory of toArray(options.destination || [])) {
            const newDestinations = await destinationFactory(completedGoal, gi);
            if (!!newDestinations) {
                destinations.push(...toArray(newDestinations));
            }
        }

        if (destinations.length > 0) {
            const msg = await options.notification(gi);
            for (const destination of destinations) {
                await context.messageClient.send(msg.message, destination, msg.options);
            }
        }
    };
}
