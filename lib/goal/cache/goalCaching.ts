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
    GitProject,
    Project,
    projectUtils,
} from "@atomist/automation-client";
import {
    AnyPush,
    ExecuteGoalResult,
    GoalInvocation,
    GoalProjectListener,
    GoalProjectListenerEvent,
    GoalProjectListenerRegistration,
    predicatePushTest,
    pushTest,
    PushTest,
} from "@atomist/sdm";
import * as _ from "lodash";
import { toArray } from "../../util/misc/array";
import { NoOpGoalCache } from "./NoOpGoalCache";

/**
 * Goal cache interface for storing and retrieving arbitrary files produced
 * by the execution of a goal.
 * @see FileSystemGoalCache`
 */
export interface GoalCache {

    put(gi: GoalInvocation, p: GitProject, file: string[], classifier?: string): Promise<void>;

    retrieve(gi: GoalInvocation, p: GitProject, classifier?: string): Promise<void>;

    remove(gi: GoalInvocation, classifier?: string): Promise<void>;
}

/**
 * Options for goal caching
 */
export interface GoalCacheOptions {
    /**
     * Optional push test on when to trigger caching
     */
    pushTest?: PushTest;
    /**
     * Collection of glob patterns with classifiers to determine which files need to be cached between
     * goal invocations.
     */
    entries: Array<{ classifier: string, pattern: string | string[] }>;
    /**
     * Optional listener functions that should be called when no cache entry is found.
     */
    onCacheMiss?: GoalProjectListenerRegistration | GoalProjectListenerRegistration[];
}

const DefaultGoalCache = new NoOpGoalCache();

/**
 * Goal listener that performs caching after a goal has been run.
 * @param options The options for caching
 * @param classifier Whether only a specific classifier, as defined in the options,
 * needs to be cached. If omitted, all classifiers are cached.
 */
export function cachePut(options: GoalCacheOptions,
                         classifier?: string): GoalProjectListenerRegistration {
    return {
        name: "cache put",
        listener: async (p: GitProject,
                         gi: GoalInvocation): Promise<void | ExecuteGoalResult> => {
            if (!!isCacheEnabled(gi)) {
                const goalCache = (gi.configuration.sdm.goalCache || DefaultGoalCache) as GoalCache;
                const entries = !!classifier ?
                    options.entries.filter(pattern => pattern.classifier === classifier) :
                    options.entries;
                for (const entry of entries) {
                    const files = await getFilePathsThroughPattern(p, entry.pattern);
                    if (!_.isEmpty(files)) {
                        await goalCache.put(gi, p, files, entry.classifier);
                    }
                }
            }
        },
        pushTest: options.pushTest,
        events: [GoalProjectListenerEvent.after],
    };
}

async function invokeCacheMissListeners(optsToUse: GoalCacheOptions,
                                        p: GitProject,
                                        gi: GoalInvocation,
                                        event: GoalProjectListenerEvent): Promise<void> {
    for (const cacheMissFallback of toArray(optsToUse.onCacheMiss)) {
        const allEvents = [GoalProjectListenerEvent.before, GoalProjectListenerEvent.after];
        if((cacheMissFallback.events || allEvents).filter(e => e === event).length > 0 && await (cacheMissFallback.pushTest || AnyPush).mapping({
            push: gi.goalEvent.push,
            project: p,
            id: gi.id,
            configuration: gi.configuration,
            addressChannels: gi.addressChannels,
            context: gi.context,
            preferences: gi.preferences,
            credentials: gi.credentials,
        })) {
            await cacheMissFallback.listener(p, gi, event);
        }
    }
}

export const NoOpGoalProjectListenerRegistration: GoalProjectListenerRegistration = {
    name: "NoOpListener",
    listener: async () => {},
    pushTest: AnyPush,
}

/**
 * Goal listener that performs cache restores before a goal has been run.
 * @param options The options for caching
 * @param classifier Whether only a specific classifier, as defined in the options,
 * needs to be restored. If omitted, all classifiers are restored.
 * @param classifiers Additional classifiers that need to be restored.
 */
export function cacheRestore(options: GoalCacheOptions,
                             classifier: string = "default",
                             ...classifiers: string[]): GoalProjectListenerRegistration {
    const optsToUse: GoalCacheOptions = {
        onCacheMiss: NoOpGoalProjectListenerRegistration,
        ...options,
    };
    return {
        name: "cache restore",
        listener: async (p: GitProject,
                         gi: GoalInvocation,
                         event: GoalProjectListenerEvent): Promise<void | ExecuteGoalResult> => {
            if (!!isCacheEnabled(gi)) {
                const goalCache = (gi.configuration.sdm.goalCache || DefaultGoalCache) as GoalCache;
                for (const c of [classifier, ...classifiers]) {
                    try {
                        await goalCache.retrieve(gi, p, c);
                    } catch (e) {
                        await invokeCacheMissListeners(optsToUse, p, gi, event);
                    }
                }
            } else {
                await invokeCacheMissListeners(optsToUse, p, gi, event);
            }
        },
        pushTest: optsToUse.pushTest,
        events: [GoalProjectListenerEvent.before],
    };
}

/**
 * Goal listener that cleans up the cache restores after a goal has been run.
 * @param options The options for caching
 * @param classifier Whether only a specific classifier, as defined in the options,
 * needs to be removed. If omitted, all classifiers are removed.
 */
export function cacheRemove(options: GoalCacheOptions,
                            classifier?: string): GoalProjectListenerRegistration {
    return {
        name: "cache remove",
        listener: async (p, gi) => {
            if (!!isCacheEnabled(gi)) {
                const goalCache = (gi.configuration.sdm.goalCache || DefaultGoalCache) as GoalCache;
                return goalCache.remove(gi, classifier);
            }
        },
        pushTest: options.pushTest,
        events: [GoalProjectListenerEvent.after],
    };
}

function getFilePathsThroughPattern(project: Project, globPattern: string | string[]): Promise<string[]> {
    return projectUtils.gatherFromFiles(project, globPattern, async f => f.path);
}

function isCacheEnabled(gi: GoalInvocation): boolean {
    return _.get(gi.configuration, "sdm.cache.enabled") || false;
}
