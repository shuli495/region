import { BaseService } from '@pighand/pighand-framework-koa';

import Mysql from '../../config/db/Mysql';
import { QueryParamInterface } from '../common/Interface';

/**
 * 行政区服务
 */
class RegionService extends BaseService() {
    private readonly tableNames: Record<string, string> = {
        '100': 'continent',
        '200': 'country',
        cn_300: 'cn_province',
        cn_500: 'cn_city',
        cn_600: 'cn_area',
        cn_700: 'cn_street',
        cn_800: 'cn_village',
        ot_300: 'ot_province',
        ot_500: 'ot_city',
        ot_600: 'ot_area',
        ot_700: 'ot_street',
        ot_800: 'ot_village',
    };

    private readonly tableColumns = new Set([
        'id',
        'parent_id',
        'parent_path',
        'level_type',
        'next_level_type',
        'name_cn',
        'name_en',
        'name_other',
        'name_pinyin',
        'name_jianpin',
        'region_code',
        'phone_code',
        'zone',
        'utc',
        'lng',
        'lat',
        'capital',
        'osm_id',
        'geo_names_id',
    ]);

    /**
     * 获取表名
     * @param level_type 格式：大洲-100；国家-200；其他：国家代码_行政区等级类型，如：cn_300
     * @returns
     */
    private _getTableName(level_type = '100') {
        const tableName = this.tableNames[level_type];
        if (!tableName) {
            super.throw('行政区等级类型错误');
        }

        return tableName;
    }

    /**
     * 列表查询
     *
     * @param queryParam 传size&&current为分页查询
     */
    async query(queryParam: QueryParamInterface) {
        const { parent_id, level_type, keyword, size, current, columns } =
            queryParam;

        const hasPageParam = size !== undefined || current !== undefined;
        const pageSize = Number(size);
        const currentPage = Number(current);
        if (
            hasPageParam &&
            (!Number.isInteger(pageSize) ||
                pageSize < 1 ||
                pageSize > 1000 ||
                !Number.isInteger(currentPage) ||
                currentPage < 1)
        ) {
            super.throw('分页参数错误');
        }

        // 组长sql
        // select
        let selectColumns = ['id', 'next_level_type', 'name_cn', 'name_en'];

        const extraColumns = columns
            ? typeof columns === 'string'
                ? [columns]
                : columns
            : [];
        for (const column of extraColumns) {
            if (!this.tableColumns.has(column)) {
                super.throw('返回字段错误');
            }

            selectColumns.push(column);
        }
        selectColumns = [...new Set(selectColumns)];

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
        if (hasPageParam) {
            // 分页查询total
            const totalSql = `SELECT COUNT(*) as total FROM ${tableName} ${where}`;
            [totalRows] = await Mysql.client.execute(totalSql, whereValues);

            pageSql = 'LIMIT ? OFFSET ?';
        }

        // 数据
        const dataSql = `SELECT ${selectColumns.join(
            ', ',
        )} FROM ${tableName} ${where} order by id ${pageSql}`;
        const dataValues = hasPageParam
            ? [...whereValues, pageSize, pageSize * (currentPage - 1)]
            : whereValues;
        const [dataRows] = await Mysql.client.execute(dataSql, dataValues);

        if (hasPageParam) {
            return {
                page: {
                    total: totalRows[0].total,
                    size: pageSize,
                    current: currentPage,
                },
                records: dataRows,
            };
        }

        return dataRows;
    }
}

export default new RegionService();
