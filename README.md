# 全球行政区划
国外数据来自 [**geonames**](https://www.geonames.org/), [**openstreetmap**](https://www.openstreetmap.org/)

国内数据（包含港澳台）。港澳台基于自己整理，大陆数据来自 [**民政部**](https://www.mca.gov.cn/n156/n186/index.html)

项目包含数据和代码
1. 数据\
sql格式。包含全量数据和更新的增量数据。\
增量数据会同步到全量数据中，想获取最新的全部数据直接获取全量数据即可。

2. 代码\
是基于Koa2的接口服务。\
支持查询接口，自动更新数据和代码。

## 数据
暂时只提供sql

### 全量数据
> /data/full

| 文件名 | 描述 |
| --- | --- |
| continent.sql | 大洲 |
| country.sql | 国家（包含港澳台） |
| cn_province.sql | 中国 - 省、自治区、直辖市、特别行政区 |
| cn_city.sql | 中国 - 地级市 |
| cn_area.sql | 中国 - 区县 |
| cn_street.sql | 中国 - 乡镇、街道 |
| cn_village.sql | 中国 - 村委会、居委会 |
| ot_province.sql | 国外 - 省 |
| ot_city.sql | 国外 - 市 |
| ot_area.sql | 国外 - 区县 |
| ot_street.sql | 国外 - 镇 |
| ot_village.sql | 国外 - 村 |
| version.sql | 数据版本 |

### 增量数据
文件名是版本号
```
# 大洲、国家
/data/incremental/base

# 中国
/data/incremental/cn

# 其他国家
/data/incremental/other
```

### 内容结构说明
**行政区划数据**
| 字段 | 描述 |
| --- | --- |
| id | 区划代码 |
| parent_id | 父节点id |
| parent_path | 父节点id路径 |
| level_type | 等级类型 210国家 310省 320自治区 410直辖市 420特别行政区 510地级市 520地区 530自治州 540盟 610县级市 620县 630自治县 640旗 650自治旗 660特区 670林区 710镇 720乡 730民族乡 740苏木 750民族苏木 760街道 770区公所 780兵团 810街道 820村 |
| next_level_type | 下级行政区划所在表 300-(cn/ot/...)_province表 500-(cn/ot/...)_city表 600-(cn/ot/...)_area表 700-(cn/ot/...)_street表 800-(cn/ot/...)_village表 |
| name_cn | 中文名 |
| name_en | 英文名 |
| name_other | 其他语言名。部分国外数据是当地语言名。中国是去掉行政区等级，如name_cn=北京市，name_other=北京 |
| name_pinyin | 拼音 - 全拼 |
| name_jianpin | 拼音 - 简拼 |
| region_code | 行政区代码、邮编 |
| phone_code | 手机号区号 |
| zone | 区域 1北半球国家、北方城市 2南半球国家、南半球城市 |
| utc | 时区 |
| lng | 经度 |
| lat | 维度 |
| capital | 是否是首都、省会 |
| osm_id | openstreetmap id |
| geo_names_id | geonames id |

**版本信息数据(version表)**
| 字段 | 描述 |
| --- | --- |
| id | 主键 |
| type | 版本类型 code-代码 base-基础数据（大洲、国家） cn-国内 other-国外  |
| change_content_html | 变更原始内容 - html格式，来源：民政部更新内容 |
| change_content_text | 变更原始内容 - text格式，来源：民政部更新内容 |
| update_sql | 更新sql |
| revert_sql | 回滚sql |
| version | 版本号 |
| current | 是否当前版本 |
| source | 来源 10-git 20-民政部 |

## 代码
### 查询接口
> GET /region

**Query:**
| 参数 | 描述 |
| --- | --- |
| size | 分页 - 每页数据量。不传返回列表 |
| current | 分页 - 当前页码。不传返回列表 |
| columns | 额外返回的字段。默认返回'id', 'next_level_type', 'name_cn', 'name_en' |
| parent_id | 父节点id。不填或100，默认查大洲(continent)的数据 |
| level_type | 当前查询的类型。不填默认查大洲(continent)的数据。查子数据传父节点返回的'next_level_type' |
| keyword | 关键词查询。模糊搜索'name_cn', 'name_en', 'name_other', 'name_pinyin', 'name_jianpin' |

**Response:**
1. 参数传size和current返回分页数据
```json
{
  "code": 200,
  "data": {
    "total": 7,
    "size": 10,
    "current": 1,
    "records": [
      {
        "id": 1,
        "next_level_type": 300,
        "name_cn": "亚洲",
        "name_en": "Asia"
      },
      ...
    ]
  }
}
```

2. 参数不传size和current返回列表
```json
{
  "code": 200,
  "data": [
    {
      "id": 1,
      "next_level_type": 300,
      "name_cn": "亚洲",
      "name_en": "Asia"
    },
    ...
  ]
}
```

**Example:**\
查询中国省份
```
> 127.0.0.1:3099/region?parent_id=296&level_type=cn_300

{
    "code": 200,
    "data": [
        {
            "id": 110000,
            "next_level_type": "cn_600",
            "name_cn": "北京市",
            "name_en": "Beijing"
        },
        {
            "id": 130000,
            "next_level_type": "cn_500",
            "name_cn": "河北省",
            "name_en": "Hebei"
        },
        {
            "id": 650000,
            "next_level_type": "cn_500",
            "name_cn": "新疆维吾尔自治区",
            "name_en": "Xinjiang"
        },
        {
            "id": 710000,
            "next_level_type": "cn_500",
            "name_cn": "台湾省",
            "name_en": "Taiwan"
        },
        {
            "id": 810000,
            "next_level_type": "cn_600",
            "name_cn": "香港",
            "name_en": "Hong Kong"
        },
        ...
    ],
    "error": ""
}
```

### 自动更新数据和代码
#### 每日0点自动执行
1. 检查git是否有更新，有更新则拉取代码，根据增量更新的版本号，更新版本数据
2. 检查民政部数据，有更新则将更新的文字内容保存到版本数据中（**TODO：使用LLM自动生成sql**）
3. 根据版本数据中的升级sql，更新行政区划数据

#### 配置文件
默认：/config/config_default.js

开发：/config/config_dev.js

生产：/config/config_production.js

优先级：生产 | 开发 > 默认

```
port: 3099 // 服务端口

version_check_corn: '0 0 0 * * *'  // 每日0点执行
version_auto_update: true  // 是否自动更新行政区划数据。false则不执行上面第3步

restart_command: 'yarn pm2:pro'  // 重启命令
```

#### 部署和启动
1. 初始化数据库
> /data/full

2. 启动项目

2.1. 使用node或VSCode等工具启动（建议本地调试时使用）\
配置："/config/config_dev" + "/config/config_default"

* *dev环境没配置restart_command，更新代码后不会自动重启*
```shell
> npm i -g yarn
> yarn build
> yarn watch  #动态编译，不改代码不需要执行
> yarn run
```

2.2. 使用PM2启动（建议部署是使用）\
配置："/config/config_production" + "/config/config_default"
```shell
> npm i -g pm2 yarn
> yarn build
> yarn pm2:pro
```
