import { DataHistoryService } from './DataHistoryService';
import { PatchService } from './PatchService';
import Mysql from '../../config/db/Mysql';
import { McaSyncService } from './McaSyncService';

class VersionService {
    private sync: McaSyncService;
    history: DataHistoryService;
    patches: PatchService;
    async setup() {
        this.sync = new McaSyncService(Mysql.client);
        await this.sync.setup();
        this.history = new DataHistoryService(Mysql.client);
        this.patches = new PatchService(Mysql.client);
        await this.patches.setup();
    }
    async checkNewVersion(immediate = false) {
        return this.sync.run(new Date(), immediate);
    }
    async preferRemote(version: number) {
        const result = await this.sync.preferRemote(version);
        void this.sync.run().catch(console.error);
        return result;
    }
    async conflicts(version: number) {
        return this.sync.conflicts(version);
    }
    async resolve(
        version: number,
        resolutions: {
            code: string;
            action: string;
            fingerprint: string;
            target_code?: string;
        }[],
    ) {
        const result = await this.sync.resolve(version, resolutions);
        if (result.ready) void this.sync.run().catch(console.error);
        return result;
    }
    async status() {
        const [status, patches] = await Promise.all([
            this.sync.status(),
            this.patches.status(),
        ]);
        return { ...status, patches };
    }
}
export default new VersionService();
