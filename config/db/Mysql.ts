import mysql2 from 'mysql2';
import { Pool } from 'mysql2/promise';
import config from '../config';
import { DBAbstract, DBTypeEnum } from './DBAbstract';

const {
    mysql_database,
    mysql_username,
    mysql_password,
    mysql_host,
    mysql_port = 3306,
} = config;

class Mysql extends DBAbstract<Pool> {
    constructor() {
        if (
            mysql_host &&
            (!mysql_username || !mysql_password || !mysql_database)
        ) {
            throw new Error(
                '配置 MINE_MYSQL_HOST 时，必须同时配置 MINE_MYSQL_USER、MINE_MYSQL_PASSWORD 和 MINE_MYSQL_DATABASE',
            );
        }

        super(DBTypeEnum.MYSQL, !!mysql_host);
    }

    async DBConnect() {
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
