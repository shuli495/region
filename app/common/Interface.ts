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
