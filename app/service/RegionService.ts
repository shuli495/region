import Mysql from '../../config/db/Mysql';
import { QueryParamInterface, SearchParamInterface } from '../common/Interface';

const coreColumns = new Set([
    'id',
    'parent_id',
    'code',
    'level_type',
    'depth',
    'has_children',
    'name_cn',
    'name_en',
    'name_local',
    'name_pinyin',
    'name_jianpin',
]);

const detailColumns = new Set([
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

/** 行政区服务 */
class RegionService {
    private fail(message: string): never {
        throw new Error(message);
    }
    async query(queryParam: QueryParamInterface = {}) {
        const parentId = this._optionalPositiveInteger(queryParam.parent_id);
        const afterId =
            this._optionalPositiveInteger(queryParam.after_id, true) || 0;
        const pageSize = this._pageSize(queryParam.size);
        const requestedColumns = queryParam.columns
            ? typeof queryParam.columns === 'string'
                ? [queryParam.columns]
                : queryParam.columns
            : [];

        const selectColumns = new Set([
            'id',
            'code',
            'level_type',
            'has_children',
            'name_cn',
            'name_en',
        ]);
        let needsDetail = false;
        for (const column of requestedColumns) {
            if (!coreColumns.has(column) && !detailColumns.has(column)) {
                this.fail('返回字段错误');
            }
            selectColumns.add(column);
            needsDetail ||= detailColumns.has(column);
        }

        const selectedSql = [...selectColumns]
            .map((column) =>
                detailColumns.has(column) ? `d.${column}` : `r.${column}`,
            )
            .join(', ');
        const join = needsDetail
            ? 'LEFT JOIN region_detail d ON d.region_id = r.id'
            : '';
        const whereValues: number[] = [];
        const parentWhere =
            parentId === undefined
                ? 'r.parent_id IS NULL'
                : (whereValues.push(parentId), 'r.parent_id = ?');
        whereValues.push(afterId);

        const sql = `SELECT ${selectedSql} FROM region r ${join} WHERE ${parentWhere} AND r.id > ? ORDER BY r.id LIMIT ${pageSize + 1}`;
        const [rows]: any[] = await Mysql.client.execute(sql, whereValues);

        return this._page(rows, pageSize, 'id');
    }

    async search(queryParam: SearchParamInterface) {
        const keyword = queryParam.keyword?.trim();
        if (!keyword || keyword.length > 128) {
            this.fail('搜索关键词错误');
        }

        const parentId = this._optionalPositiveInteger(queryParam.parent_id);
        if (parentId === undefined) {
            this.fail('搜索必须指定父节点');
        }
        const afterId =
            this._optionalPositiveInteger(queryParam.after_id, true) || 0;
        const pageSize = this._pageSize(queryParam.size);
        const values = [parentId, keyword, afterId];

        const [rows]: any[] = await Mysql.client.execute(
            `SELECT region_id FROM region_search WHERE parent_id = ? AND INSTR(search_text, ?) > 0 AND region_id > ? ORDER BY region_id LIMIT ${pageSize + 1}`,
            values,
        );

        return this._page(rows, pageSize, 'region_id');
    }

    private _page(rows: any[], pageSize: number, idColumn: string) {
        const hasMore = rows.length > pageSize;
        const records = hasMore ? rows.slice(0, pageSize) : rows;

        return {
            records,
            has_more: hasMore,
            next_after_id: hasMore ? records.at(-1)[idColumn] : null,
        };
    }

    private _pageSize(value?: number) {
        if (value === undefined) {
            return 200;
        }

        const size = Number(value);
        if (!Number.isInteger(size) || size < 1 || size > 1000) {
            this.fail('分页参数错误');
        }

        return size;
    }

    private _optionalPositiveInteger(value?: number, allowZero = false) {
        if (value === undefined || value === null || value === ('' as any)) {
            return undefined;
        }

        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
            this.fail('ID参数错误');
        }

        return parsed;
    }
}

export default new RegionService();
