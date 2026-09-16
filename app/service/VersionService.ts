import { DataHistoryService } from './DataHistoryService';
import Mysql from '../../config/db/Mysql';
import { McaSyncService } from './McaSyncService';

class VersionService {
    private sync: McaSyncService;
    history: DataHistoryService;
    async setup() {
        this.sync = new McaSyncService(Mysql.client);
        await this.sync.setup();
        this.history = new DataHistoryService(Mysql.client);
    }
    async checkNewVersion() {
        return this.sync.run();
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
        return this.sync.status();
    }
}
export default new VersionService();
