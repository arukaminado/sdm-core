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
    EventFired,
    GraphQL,
    HandlerContext,
    HandlerResult,
    logger,
    Success,
} from "@atomist/automation-client";
import { EventHandler } from "@atomist/automation-client/lib/decorators";
import { HandleEvent } from "@atomist/automation-client/lib/HandleEvent";
import {
    addressChannelsFor,
    CredentialsResolver,
    NewIssueListener,
    NewIssueListenerInvocation,
    PreferenceStoreFactory,
    RepoRefResolver,
} from "@atomist/sdm";
import * as schema from "@atomist/sdm/lib/typings/types";

/**
 * A new issue has been created.
 */
@EventHandler("On issue creation", GraphQL.subscription("OnIssueAction"))
export class NewIssueHandler implements HandleEvent<schema.OnIssueAction.Subscription> {

    private readonly newIssueListeners: NewIssueListener[];

    constructor(newIssueListeners: NewIssueListener[],
                private readonly repoRefResolver: RepoRefResolver,
                private readonly credentialsFactory: CredentialsResolver,
                private readonly preferenceStoreFactory: PreferenceStoreFactory) {
        this.newIssueListeners = newIssueListeners;
    }

    public async handle(event: EventFired<schema.OnIssueAction.Subscription>,
                        context: HandlerContext): Promise<HandlerResult> {
        const issue = event.data.Issue[0];
        const addressChannels = addressChannelsFor(issue.repo, context);
        const id = this.repoRefResolver.toRemoteRepoRef(issue.repo, {});

        if (issue.updatedAt !== issue.createdAt) {
            logger.debug("Issue updated, not created: %s on %j", issue.number, id);
            return Success;
        }
        const credentials = this.credentialsFactory.eventHandlerCredentials(context, id);
        const preferences = this.preferenceStoreFactory(context);

        const inv: NewIssueListenerInvocation = {
            id,
            addressChannels,
            preferences,
            context,
            issue,
            credentials,
        };
        await Promise.all(this.newIssueListeners
            .map(l => l(inv)));
        return Success;
    }
}
