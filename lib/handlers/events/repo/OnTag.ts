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
    EventFired,
    GraphQL,
    HandleEvent,
    HandlerContext,
    HandlerResult,
    Success,
} from "@atomist/automation-client";
import { EventHandler } from "@atomist/automation-client/lib/decorators";
import {
    addressChannelsFor,
    CredentialsResolver,
    RepoRefResolver,
    TagListener,
    TagListenerInvocation,
} from "@atomist/sdm";
import * as schema from "@atomist/sdm/lib/typings/types";

/**
 * A new tag has been created
 */
@EventHandler("On tag", GraphQL.subscription("OnTag"))
export class OnTag implements HandleEvent<schema.OnTag.Subscription> {

    constructor(private readonly listeners: TagListener[],
                private readonly repoRefResolver: RepoRefResolver,
                private readonly credentialsFactory: CredentialsResolver) {}

    public async handle(event: EventFired<schema.OnTag.Subscription>,
                        context: HandlerContext,
                        params: this): Promise<HandlerResult> {
        const tag = event.data.Tag[0];
        const repo = tag.commit.repo;
        const id = params.repoRefResolver.toRemoteRepoRef(repo, {});
        const credentials = this.credentialsFactory.eventHandlerCredentials(context, id);
        const addressChannels = addressChannelsFor(repo, context);
        const invocation: TagListenerInvocation = {
            addressChannels,
            id,
            context,
            tag,
            credentials,
        };
        await Promise.all(params.listeners.map(l => l(invocation)));
        return Success;
    }
}