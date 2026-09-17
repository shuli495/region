import mysql2 from 'mysql2';
import { Pool } from 'mysql2/promise';
import config from '../config';

const {
    mysql_database,
    mysql_username,
    mysql_password,
    mysql_host,
    mysql_port = 3306,
} = config;

class Mysql {
    client: Pool;
    constructor() {
        if (
            mysql_host &&
            (!mysql_username || !mysql_password || !mysql_database)
        ) {
            throw new Error(
                '配置 MINE_MYSQL_HOST 时，必须同时配置 MINE_MYSQL_USER、MINE_MYSQL_PASSWORD 和 MINE_MYSQL_DATABASE',
            );
        }
    }

    async connect() {
        if (!mysql_host) {
            console.warn('mysql - 未配置');
            return this.client;
        }
        try {
            this.client = await this.DBConnect();
            console.info('mysql - 已连接');
        } catch (e) {
            console.error('mysql - 连接错误');
            throw new Error(e);
        }
        return this.client;
    }

    private async DBConnect() {
        const pool = mysql2.createPool({
            host: mysql_host,
            port: mysql_port,
            user: mysql_username,
            password: mysql_password,
            database: mysql_database,

            waitForConnections: true,
            connectionLimit: 10,
            maxIdle: 10,
            idleTimeout: 60000,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            supportBigNumbers: true,
            bigNumberStrings: true,
        });

        return pool.promise();
    }
}

const mysql = new Mysql();

export default mysql;
