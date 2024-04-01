import { BaseService } from '@pighand/pighand-framework-koa';

import Mysql from '../../config/db/Mysql';
import { QueryParamInterface } from '../common/Interface';

/**
 * 行政区服务
 */
class RegionService extends BaseService() {
    /**
     * 获取表名
     * @param level_type 格式：大洲-100；国家-200；其他：国家代码_行政区等级类型，如：cn_300
     * @returns
     */
    private _getTableName(level_type = '100') {
        switch (level_type) {
            case '100':
                return 'continent';
            case '200':
                return 'country';
            default:
                const levelInfos = level_type.split('_');
                const countryCode = levelInfos[0];

                switch (levelInfos[1]) {
                    case '300':
                        return `${countryCode}_province`;
                    case '500':
                        return `${countryCode}_city`;
                    case '600':
                        return `${countryCode}_area`;
                    case '700':
                        return `${countryCode}_street`;
                    case '800':
                        return `${countryCode}_village`;
                    default:
                        super.throw('行政区等级类型错误');
                }
        }
    }

    /**
     * 列表查询
     *
     * @param queryParam 传size&&current为分页查询
     */
    async query(queryParam: QueryParamInterface) {
        const { parent_id, level_type, keyword, size, current, columns } =
            queryParam;

        const isPage = size && current;

        // 组长sql
        // select
        let selectColumns = ['id', 'next_level_type', 'name_cn', 'name_en'];

        if (columns) {
            if (typeof columns === 'string') {
                selectColumns.push(columns);
            } else {
                selectColumns = selectColumns.concat(columns);
            }
        }

        // table
        const tableName = this._getTableName(level_type);

        // where
        let where = 'WHERE 1=1';
        const whereValues = [];
        if (parent_id && level_type && level_type != '100') {
            where += ` AND parent_id = ?`;
            whereValues.push(parent_id);
        }

        if (keyword) {
            where +=
                ` AND (name_cn LIKE CONCAT('%', ?,  '%') ` +
                `or name_en LIKE CONCAT('%', ?,  '%') ` +
                `or name_other LIKE CONCAT('%', ?,  '%') ` +
                `or name_pinyin LIKE CONCAT('%', ?,  '%') ` +
                `or name_jianpin LIKE CONCAT('%', ?,  '%'))`;
            whereValues.push(keyword);
            whereValues.push(keyword);
            whereValues.push(keyword);
            whereValues.push(keyword);
            whereValues.push(keyword);
        }

        // 分页
        let pageSql = '';
        let totalRows: any;
        if (isPage) {
            // limit
            pageSql = isPage ? `LIMIT ${size * (current - 1)}, ${size}` : '';

            // 分页查询total
            const totalSql = `SELECT COUNT(*) as total FROM ${tableName} ${where}`;
            [totalRows] = await Mysql.client.execute(totalSql, whereValues);
        }

        // 数据
        const dataSql = `SELECT ${selectColumns.join(
            ', ',
        )} FROM ${tableName} ${where} order by id ${pageSql}`;
        const [dataRows] = await Mysql.client.execute(dataSql, whereValues);

        if (isPage) {
            return {
                page: {
                    total: totalRows[0].total,
                    size: Number(size),
                    current: Number(current),
                },
                records: dataRows,
            };
        }

        return dataRows;
    }
}

export default new RegionService();
