/*
 * Copyright © 2018 Atomist, Inc.
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
    MappedParameter,
    MappedParameters,
    Parameter,
    Success,
    Value,
} from "@atomist/automation-client";
import { Parameters } from "@atomist/automation-client/decorators";
import { CommandHandlerRegistration, CommandListenerInvocation, SoftwareDeliveryMachine } from "@atomist/sdm";
import { chooseAndSetGoals } from "@atomist/sdm/api-helper/goal/chooseAndSetGoals";
import {
    success,
    warning,
} from "@atomist/sdm/api-helper/misc/slack/messages";
import { GoalImplementationMapper } from "@atomist/sdm/api/goal/support/GoalImplementationMapper";
import { GoalsSetListener } from "@atomist/sdm/api/listener/GoalsSetListener";
import { GoalSetter } from "@atomist/sdm/api/mapping/GoalSetter";
import { ProjectLoader } from "@atomist/sdm/spi/project/ProjectLoader";
import { RepoRefResolver } from "@atomist/sdm/spi/repo-ref/RepoRefResolver";
import {
    bold,
    codeLine,
    italic,
} from "@atomist/slack-messages";
import {
    PushForCommit,
    RepoBranchTips,
} from "../../typings/types";
import { fetchDefaultBranchTip, fetchPushForCommit, tipOfBranch } from "../../util/graph/queryCommits";

@Parameters()
export class ResetGoalsParameters {

    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: false })
    public sha: string;

    @Parameter({ required: false })
    public branch: string;

    @Value("name")
    public name: string;

    @Value("version")
    public version: string;

}

export function resetGoalsCommand(sdm: SoftwareDeliveryMachine): CommandHandlerRegistration {
    return {
        name: "ResetGoalsOnCommit",
        paramsMaker: ResetGoalsParameters,
        listener: resetGoalsOnCommit(sdm),
        intent: ["reset goals"],
    };
}

function resetGoalsOnCommit(sdm: SoftwareDeliveryMachine) {
    return async (cli: CommandListenerInvocation<ResetGoalsParameters>) => {
        const rules = {
            projectLoader: sdm.configuration.sdm.projectLoader,
            repoRefResolver: sdm.configuration.sdm.repoRefResolver,
            goalsListeners: sdm.goalsSetListeners,
            goalSetter: sdm.pushMapping,
            implementationMapping: sdm.goalFulfillmentMapper,
        }

        const commandParams = cli.parameters;
        const repoData = await fetchDefaultBranchTip(cli.context, cli.parameters);
        const branch = commandParams.branch || repoData.defaultBranch;
        const sha = commandParams.sha || tipOfBranch(repoData, branch);
        const id = rules.repoRefResolver.toRemoteRepoRef({
            owner: commandParams.owner, name: commandParams.repo,
            org: { owner: commandParams.owner, provider: { providerId: commandParams.providerId } },
        }, { sha, branch });

        const push = await fetchPushForCommit(cli.context, id, commandParams.providerId);

        const goals = await chooseAndSetGoals(rules, {
            context: cli.context,
            credentials: cli.credentials,
            push,
        });

        if (goals) {
            await cli.addressChannels(success(
                "Plan Goals",
                `Successfully planned goals on ${codeLine(sha.slice(0, 7))} of ${
                bold(`${commandParams.owner}/${commandParams.repo}/${branch}`)} to ${italic(goals.name)}`,
                {
                    footer: `${commandParams.name}:${commandParams.version}`,
                }));
        } else {
            await cli.addressChannels(warning(
                "Plan Goals",
                `No goals found for ${codeLine(sha.slice(0, 7))} of ${
                bold(`${commandParams.owner}/${commandParams.repo}/${branch}`)}`,
                cli.context,
                {
                    footer: `${commandParams.name}:${commandParams.version}`,
                }));
        }

        return Success;
    };
}