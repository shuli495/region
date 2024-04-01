export enum DBTypeEnum {
    MYSQL = 'mysql',
    MONGO = 'mongo',
    REDIS = 'redis',
}

export abstract class DBAbstract<T> {
    /**
     * db类型
     */
    DBType: DBTypeEnum;

    /**
     * 是否配置db
     */
    isConfigureDB = false;

    /**
     * db连接
     */
    client: T;

    constructor(DBType: DBTypeEnum, isConfigureDB: boolean) {
        this.DBType = DBType;
        this.isConfigureDB = isConfigureDB;
    }

    /**
     * 连接数据库
     */
    async connect() {
        if (this.isConfigureDB) {
            try {
                this.client = await this.DBConnect();

                console.info(`${this.DBType} - 已连接`);
            } catch (e) {
                console.error(`${this.DBType} - 连接错误`);

                throw new Error(e);
            }
        } else {
            console.warn(`${this.DBType} - 未配置`);
        }

        return this.client;
    }

    /**
     * 数据库连接实现方法
     */
    abstract DBConnect(): Promise<any>;
}

export default DBAbstract;
