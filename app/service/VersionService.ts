import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import { simpleGit } from 'simple-git';
import { BaseService } from '@pighand/pighand-framework-koa';

import config from '../../config/config';
import Mysql from '../../config/db/Mysql';
import { VersionType, VersionMapInterface } from '../common/Interface';

// 项目根目录
const rootDirectory = path.resolve(__dirname, '..', '..', '..');

/**
 * 版本号
 *
 * @author wangshuli
 * @createDate 2024-03-11 19:46:02
 */
class VersionService extends BaseService() {
    /**
     * 查询民政部最新消息
     * 1. 查询发布列表，发布日期作为版本号
     * 2. 查询发布详情页，获取有”变更“字样的链接
     * 3. 查询变更链接，获取变更内容
     *
     * @param nowVersion 当前版本号。大于等于民政部版本号的不处理
     *
     * @return
     *  changeContentHtml - 变更内容html格式
     *  changeContentText - 变更内容纯文本格式
     */
    async getMCA(nowVersion = 0) {
        // 查询民政部行政区划发布信息
        const url = 'https://www.mca.gov.cn/n156/n186/index.html';
        const html = await axios.get(url);

        if (html.status !== 200) {
            console.error('get mca error\n' + html.data);
            return;
        }

        // 第一个tr中的第一个td是最新版本号（发布日期）
        const $ = cheerio.load(html.data);
        const newVersion = $('tr:first-child td:last-child')
            .first()
            .text()
            .trim()
            .replaceAll('-', '');

        // 无新内容忽略
        if (nowVersion >= Number(newVersion)) {
            return;
        }

        // 第一个tr中的第二个td是详情页链接
        const hrefValue = $('tr:first-child td:nth-child(2) a').attr('href');
        const baseURL = new URL(url);
        const combinedURL = new URL(hrefValue, baseURL).href;

        // 打开详情页
        const detailHtml = await axios.get(combinedURL);
        if (detailHtml.status !== 200) {
            console.error('get mca detail error\n' + detailHtml.data);
            return;
        }

        // 获取正文中，有“变更”字样的链接
        const detail$ = cheerio.load(detailHtml.data);
        const pTags = detail$('.content').find('p');
        const changeUrls = pTags
            .find('a')
            .filter((index, element) => $(element).text().includes('变更'))
            .map((index, element) => $(element).attr('href'))
            .toArray();

        // 获取变更内容
        const changeContentHtml = [];
        const changeContentText = [];
        for (const changeUrl of changeUrls) {
            const changeHtml = await axios.get(changeUrl);
            if (changeHtml.status !== 200) {
                console.error(
                    `get mca change error\n${changeUrl}\n${changeHtml.data}`,
                );
                return;
            }

            const change$ = cheerio.load(changeHtml.data);
            changeContentHtml.push(change$('body').html());
            changeContentText.push(change$('body').text());
        }

        return {
            version: Number(newVersion),
            changeContentHtml,
            changeContentText,
            versionSql: '',
        };
    }

    /**
     * 查询git版本好
     * @returns version - 版本号
     */
    async getGit(): Promise<{ version: number }> {
        // 查询git版本
        const url =
            'https://github.com/pighand-com/pighand-framework-spring-parent/releases';

        const html = await axios.get(url);
        if (html.status !== 200) {
            console.error('get git error\n' + html.data);
            return;
        }

        const $ = cheerio.load(html.data);
        const versionSting = $('section').first().find('.Link--primary').text();

        // 版本号是数字，直接返回
        const isNumber = !isNaN(versionSting as any);
        if (isNumber) {
            return {
                version: Number(versionSting),
            };
        }

        // 版本号是字符串，提取日期
        const regex = /(\d{4})(\d{2})(\d{2})/g;
        let match;
        while ((match = regex.exec(versionSting)) !== null) {
            const year = match[1];
            const month = match[2];
            const day = match[3];

            return {
                version: Number(year + month + day),
            };
        }

        return {
            version: 0,
        };
    }

    /**
     * 检查新版本
     * 1. 判断code是否有新版本
     * 2. code有新版本，更新代码
     * 3. 查看/data/incremental目录下是否有新版本更新文件
     * 4. 查看民政部是否有新版本
     * 5. 将更新数据存入version表
     */
    async checkNewVersion() {
        // 查询大于当前版本信息：包含当前版本、未生效的新版本
        // 正序排，用来转map时，新版本覆盖旧版本
        const [nowVersions]: any[] = await Mysql.client.query(
            'select * from version where id >= (SELECT id FROM version WHERE current = 1 order by id asc limit 1) order by id asc',
        );

        // 将version列表转为map
        const versionMap: VersionMapInterface = {
            code: {
                nowVersion: 0,
                lastVersion: 0,
                newVersion: 0,
                newVersionSql: '',
            },
            base: {
                nowVersion: 0,
                lastVersion: 0,
                newVersion: 0,
                newVersionSql: '',
            },
            cn: {
                nowVersion: 0,
                lastVersion: 0,
                newVersion: 0,
                newVersionSql: '',
            },
            other: {
                nowVersion: 0,
                lastVersion: 0,
                newVersion: 0,
                newVersionSql: '',
            },
        };

        nowVersions.forEach((item: any) => {
            const { current, type } = item;

            if (current == 1) {
                versionMap[type as VersionType].nowVersion = item.version;
            }

            versionMap[type as VersionType].lastVersion = item.version;
        });

        // 获取远程新版本
        const [mcaVersions, gitVersions] = await Promise.all([
            // 国内数据从民政部获取
            this.getMCA(versionMap.cn.lastVersion),
            // 过去git上版本
            this.getGit(),
        ]);

        // 更新代码
        if (gitVersions?.version > versionMap.code.lastVersion) {
            simpleGit(rootDirectory).pull();
        }

        // 根据当前版本号，获取新版本信息的sql
        const incrementalPath = path.join(rootDirectory, 'data', 'incremental');
        fs.readdirSync(incrementalPath)
            .filter((updateDir) =>
                fs
                    .statSync(path.join(incrementalPath, updateDir))
                    .isDirectory(),
            )
            .forEach((updateDir) => {
                this._getUploadSql(
                    path.join(incrementalPath, updateDir),
                    updateDir as VersionType,
                    versionMap,
                );
            });

        // 民政部有新数据，插入民政部数据
        if (versionMap.cn.newVersion < mcaVersions?.version) {
            versionMap.cn.newVersion = mcaVersions?.version;
            versionMap.cn.newVersionSql =
                versionMap.cn.newVersionSql + '\n' + mcaVersions?.versionSql;
        }

        // 更新版本信息数据
        const updateSql = Object.values(versionMap)
            .filter((item) => !!item.newVersionSql)
            .map((item) => item.newVersionSql)
            .join('\n');

        if (updateSql) {
            await Mysql.client.execute(updateSql);
        }

        // 更新代码版本
        await this.cutVersion(
            'code',
            versionMap.code.newVersion || versionMap.code.lastVersion,
        );

        // 切换版本
        if (config.version_auto_update) {
            await Promise.all([
                this.cutVersion(
                    'base',
                    versionMap.base.newVersion || versionMap.base.lastVersion,
                ),
                this.cutVersion(
                    'cn',
                    versionMap.cn.newVersion || versionMap.cn.lastVersion,
                ),
                this.cutVersion(
                    'other',
                    versionMap.other.newVersion || versionMap.other.lastVersion,
                ),
            ]);
        }

        // 重启服务
        if (config.restart_command) {
            execSync(config.restart_command, {
                cwd: rootDirectory,
            });
        }
    }

    /**
     * 切换版本
     * @param type
     * @param version
     */
    async cutVersion(type: VersionType, version: number) {
        if (!version) {
            return;
        }

        // 当前版本
        const [nowVersions]: any[] = await Mysql.client.query(
            'select * from version where type = ? and current = 1',
            [type],
        );

        const nowVersion = nowVersions.length && nowVersions[0];

        if (nowVersion?.version >= version) {
            return;
        }

        // 当前版本到目标版本之间的版本
        const [updateVersions]: any[] = await Mysql.client.query(
            'select * from version where version > ? and version <= ? order by version asc',
            [nowVersion?.version || 0, version],
        );

        // 从旧到新依次更新，跳过没有sql的版本
        let newVersion = version;
        for (const updateVersion of updateVersions) {
            if (updateVersion.update_sql) {
                newVersion = updateVersion.version;
                await Mysql.client.execute(updateVersion.update_sql);
            }
        }

        // 切换版本状态
        await Mysql.client.execute(
            `update version set current = 1 where type = ? and version = ?`,
            [type, newVersion],
        );

        if (nowVersion) {
            await Mysql.client.execute(
                `update version set current = 0 where id = ?`,
                [nowVersion.id],
            );
        }
    }

    /**
     * 获取更新sql，存入versionMap
     * @param uploadFilePath 更新文件路径
     * @param versionMap 版本号
     */
    private _getUploadSql(
        uploadFilePath: string,
        versionType: VersionType,
        versionMap: VersionMapInterface,
    ) {
        let lastVersion = 0;
        const uploadFiles = fs
            .readdirSync(uploadFilePath)
            .filter((filePath) => {
                lastVersion = this._getUpdateFileVersion(filePath);

                return lastVersion > versionMap[versionType].lastVersion;
            });

        if (uploadFiles.length === 0) {
            return;
        }

        versionMap[versionType].newVersion = lastVersion;
        versionMap[versionType].newVersionSql = uploadFiles
            .map((uploadFile) =>
                fs.readFileSync(path.join(uploadFilePath, uploadFile)),
            )
            .join('\n');
    }

    /**
     * 获取更新文件版本号
     * @param filePath
     * @param version
     * @returns true 大于当前版本
     */
    private _getUpdateFileVersion(filePath: string) {
        let fileVersion = 0;

        const fileName = path.parse(filePath).name;
        try {
            fileVersion = Number(fileName);
        } catch (e) {
            console.error(
                'transition file name to version error, file name ' + fileName,
            );
        }

        return fileVersion;
    }
}

export default new VersionService();
