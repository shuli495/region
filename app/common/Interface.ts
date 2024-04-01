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

// 行政区子等级类型（表中数据）
export type SubLevelType =
    // 大洲
    | '110'
    // 国家
    | '210'
    // 省
    | '310'
    // 自治区
    | '320'
    // 直辖市
    | '410'
    // 特别行政区
    | '420'
    // 地级市
    | '510'
    // 地区
    | '520'
    // 自治州
    | '530'
    // 盟
    | '540'
    // 区县
    | '610'
    // 乡镇、街道
    | '710'
    // 村委会、居委会
    | '810';

// 表列名
type TableColumn =
    | 'id'
    | 'parent_id'
    | 'parent_path'
    | 'level_type'
    | 'next_level_type'
    | 'name_cn'
    | 'name_en'
    | 'name_other'
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

    // 行政区等级类型，父表的next_level_type
    level_type?: string;

    sub_level_type?: SubLevelType;

    // 查询关键词（name相关模糊查询）
    keyword?: string;

    // 分页参数
    size?: number;
    current?: number;

    // 返回的列
    columns: TableColumn[];
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
