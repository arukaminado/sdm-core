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
    HandlerContext,
    logger,
} from "@atomist/automation-client";
import { PreferenceStoreFactory } from "@atomist/sdm";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
    lock,
    unlock,
} from "proper-lockfile";
import {
    AbstractPreferenceStore,
    Preference,
} from "./AbstractPreferenceStore";

type PreferenceFile = Record<string, { value: string, ttl?: number }>;

type WithPreferenceFile<V> = (p: PreferenceFile) => Promise<{ value?: V, save: boolean }>;

/**
 * Factory to create a new FilePreferenceStore instance
 * @param ctx
 * @constructor
 */
export const FilePreferenceStoreFactory: PreferenceStoreFactory = ctx => new FilePreferenceStore(ctx);

/**
 * PreferenceStore implementation that stores preferences in a shared file.
 * Note: this implementation attempts to lock the preference file before reading or writing to it
 * but it is not intended for production usage.
 */
export class FilePreferenceStore extends AbstractPreferenceStore {

    constructor(private readonly context: HandlerContext,
                private readonly filePath: string =
                    path.join(os.homedir(), ".atomist", "prefs", "client.prefs.json")) {
        super(context);
        this.init();
    }

    protected async doGet(key: string): Promise<Preference | undefined> {
        return this.doWithPreferenceFile<Preference | undefined>(async prefs => {
            if (!!prefs[key]) {
                return {
                    save: false,
                    value: {
                        key,
                        value: prefs[key].value,
                        ttl: prefs[key].ttl,
                    },
                };
            } else {
                return {
                    save: false,
                    value: undefined,
                };
            }
        });
    }

    protected async doPut(pref: Preference): Promise<void> {
        return this.doWithPreferenceFile<void>(async prefs => {
            prefs[pref.key] = { value: pref.value, ttl: pref.ttl };
            return {
                save: true,
            };
        });
    }

    private async read(): Promise<PreferenceFile> {
        return (await fs.readJson(this.filePath)) as PreferenceFile;
    }

    private async doWithPreferenceFile<V>(withPreferenceFile: WithPreferenceFile<V>): Promise<V> {
        await lock(this.filePath, { retries: 5 });
        const prefs = await this.read();
        let result;
        try {
            result = await withPreferenceFile(prefs);
            if (result.save) {
                await fs.writeJson(this.filePath, prefs);
            }
        } catch (e) {
            logger.error(`Operation on preference file failed: ${e.message}`);
        }
        await unlock(this.filePath);
        return result.value as V;
    }

    private init() {
        fs.ensureDirSync(path.dirname(this.filePath));
        try {
            fs.readFileSync(this.filePath);
        } catch (e) {
            fs.writeJsonSync(this.filePath, {});
        }
    }
}
