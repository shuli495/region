// 版本类型
export type VersionType =
    // 代码
    | 'code'
    // 基础数据（大洲、国家）
    | 'base'
    // 国内
    | 'cn'
    // 国外
    | 'other';

// 表列名
type TableColumn =
    | 'id'
    | 'parent_id'
    | 'code'
    | 'level_type'
    | 'depth'
    | 'has_children'
    | 'name_cn'
    | 'name_en'
    | 'name_local'
    | 'name_pinyin'
    | 'name_jianpin'
    | 'region_code'
    | 'phone_code'
    | 'zone'
    | 'utc'
    | 'lng'
    | 'lat'
    | 'capital'
    | 'osm_id'
    | 'geo_names_id';

// 行政区列表查询参数
export interface QueryParamInterface {
    parent_id?: number;
    size?: number;
    after_id?: number;

    // 返回的列
    columns?: TableColumn[] | TableColumn;
}

export interface SearchParamInterface {
    parent_id: number;
    keyword: string;
    size?: number;
    after_id?: number;
}

export type VersionMapInterface = {
    [key in VersionType]: {
        // 库中当前版本号
        nowVersion: number;

        // 库中最新版本号
        lastVersion: number;

        // 最新版本号
        newVersion: number;
        // 当前版本到最新版本的更新sql
        newVersionSql: string;
    };
};
