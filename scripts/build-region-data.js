const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');

const sourceFiles = [
    'continent.sql',
    'country.sql',
    'cn_province.sql',
    'cn_city.sql',
    'cn_area.sql',
    'cn_street.sql',
    'cn_village.sql',
    'ot_province.sql',
    'ot_city.sql',
    'ot_area.sql',
    'ot_street.sql',
    'ot_village.sql',
];

function parseValues(valueSql) {
    const values = [];
    let value = '';
    let quoted = false;
    let escaped = false;
    let jsonDepth = 0;

    for (const character of valueSql) {
        if (escaped) {
            value += character;
            escaped = false;
            continue;
        }
        if (quoted && character === '\\') {
            value += character;
            escaped = true;
            continue;
        }
        if (character === "'") {
            quoted = !quoted;
            value += character;
            continue;
        }
        if (!quoted) {
            if (character === '[' || character === '{') jsonDepth++;
            if (character === ']' || character === '}') jsonDepth--;
            if (character === ',' && jsonDepth === 0) {
                values.push(value.trim());
                value = '';
                continue;
            }
        }
        value += character;
    }
    values.push(value.trim());

    return values;
}

function decodeValue(value) {
    if (value === 'NULL') return null;
    if (!value.startsWith("'")) return value;

    const escapes = {
        0: '\0',
        b: '\b',
        n: '\n',
        r: '\r',
        t: '\t',
        Z: '\x1a',
    };
    return value
        .slice(1, -1)
        .replace(/\\(.)/g, (_, character) => escapes[character] ?? character);
}

function parseInsert(line) {
    const match = line.match(
        /^INSERT INTO `([^`]+)` \((.+)\) VALUES \((.*)\);$/,
    );
    if (!match) return null;

    const columns = [...match[2].matchAll(/`([^`]+)`/g)].map(
        (column) => column[1],
    );
    const values = parseValues(match[3]).map(decodeValue);
    if (columns.length !== values.length) {
        throw new Error(`字段和值数量不一致: ${line.slice(0, 120)}`);
    }

    return Object.fromEntries(
        columns.map((column, index) => [column, values[index]]),
    );
}

function encodeTsv(value) {
    if (value === null || value === undefined || value === '') return '\\N';
    return String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('\t', '\\t')
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n');
}

class ChunkWriter {
    constructor(outputDirectory, prefix, columns, maxBytes) {
        this.outputDirectory = outputDirectory;
        this.prefix = prefix;
        this.columns = columns;
        this.maxBytes = maxBytes;
        this.files = [];
        this.rows = 0;
        this.index = 0;
        this.bytes = 0;
        this.stream = null;
    }

    async write(values) {
        const line = `${values.map(encodeTsv).join('\t')}\n`;
        const bytes = Buffer.byteLength(line);
        if (
            !this.stream ||
            (this.bytes && this.bytes + bytes > this.maxBytes)
        ) {
            await this.rotate();
        }
        if (!this.stream.write(line)) await once(this.stream, 'drain');
        this.bytes += bytes;
        this.rows++;
    }

    async rotate() {
        if (this.stream) {
            this.stream.end();
            await once(this.stream, 'finish');
        }
        this.index++;
        this.bytes = 0;
        const name = `${this.prefix}-${String(this.index).padStart(3, '0')}.tsv`;
        this.files.push(name);
        this.stream = fs.createWriteStream(
            path.join(this.outputDirectory, name),
        );
    }

    async close() {
        if (!this.stream) return;
        this.stream.end();
        await once(this.stream, 'finish');
    }

    manifest() {
        return { columns: this.columns, rows: this.rows, files: this.files };
    }
}

async function readRows(inputDirectory, callback) {
    for (const file of sourceFiles) {
        const filePath = path.join(inputDirectory, file);
        const lines = readline.createInterface({
            input: fs.createReadStream(filePath),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (!line.startsWith('INSERT INTO')) continue;
            const row = parseInsert(line);
            if (row) await callback(row, file);
        }
    }
}

function loadPatches(patchDirectory) {
    if (!fs.existsSync(patchDirectory))
        return { transform: (row) => row, additions: [] };

    const patchEntries = fs
        .readdirSync(patchDirectory)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({
            file,
            patch: JSON.parse(
                fs.readFileSync(path.join(patchDirectory, file), 'utf8'),
            ),
        }))
        .sort((a, b) => Number(a.patch.version) - Number(b.patch.version));
    const patches = patchEntries.map((entry) => entry.patch);
    const prefixChanges = patches
        .flatMap((patch) => patch.prefix_changes || [])
        .sort((a, b) => b.from.length - a.from.length);
    const updates = Object.assign(
        {},
        ...patches.map((patch) => patch.updates || {}),
    );
    const parentChanges = Object.assign(
        {},
        ...patches.map((patch) => patch.parent_changes || {}),
    );
    const removals = new Set(patches.flatMap((patch) => patch.removals || []));
    const additions = patches.flatMap((patch) => patch.additions || []);

    return {
        additions,
        files: patchEntries.map((entry) => entry.file),
        transform(sourceRow) {
            const row = { ...sourceRow };
            const idChange = prefixChanges.find((change) =>
                sourceRow.id.startsWith(change.from),
            );
            const parentChange = prefixChanges.find((change) =>
                sourceRow.parent_id?.startsWith(change.from),
            );
            if (idChange) {
                const exact = sourceRow.id === idChange.from;
                row.id = idChange.to + sourceRow.id.slice(idChange.from.length);
                if (exact && idChange.parent_code) {
                    row.parent_id = idChange.parent_code;
                }
            }
            if (parentChange && !(idChange && sourceRow.id === idChange.from)) {
                row.parent_id =
                    parentChange.to +
                    sourceRow.parent_id.slice(parentChange.from.length);
            }
            if (removals.has(row.id)) return null;
            Object.assign(row, updates[row.id] || {});
            if (parentChanges[row.id]) row.parent_id = parentChanges[row.id];
            return row;
        },
    };
}

function parseArguments(argv) {
    const options = {
        input: path.resolve('data/full'),
        output: path.resolve('tmp/region-data'),
        patches: path.resolve('data/patches'),
        chunkMb: 45,
    };
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (
            !value ||
            !['--input', '--output', '--patches', '--chunk-mb'].includes(key)
        ) {
            throw new Error(
                '用法: node scripts/build-region-data.js [--input DIR] [--output DIR] [--patches DIR] [--chunk-mb 45]',
            );
        }
        if (key === '--input') options.input = path.resolve(value);
        if (key === '--output') options.output = path.resolve(value);
        if (key === '--patches') options.patches = path.resolve(value);
        if (key === '--chunk-mb') options.chunkMb = Number(value);
    }
    if (!Number.isFinite(options.chunkMb) || options.chunkMb < 1) {
        throw new Error('--chunk-mb 必须是大于等于1的数字');
    }
    return options;
}

async function build(options) {
    if (
        fs.existsSync(options.output) &&
        fs.readdirSync(options.output).length
    ) {
        throw new Error(`输出目录不是空目录: ${options.output}`);
    }
    fs.mkdirSync(options.output, { recursive: true });

    const codeToId = new Map();
    const parentCodes = new Set();
    let sourceRows = 0;
    const patches = loadPatches(options.patches);

    async function readPatchedRows(callback) {
        await readRows(options.input, (sourceRow) => {
            const row = patches.transform(sourceRow);
            if (row) return callback(row);
        });
        for (const addition of patches.additions) await callback(addition);
    }

    await readPatchedRows((row) => {
        sourceRows++;
        if (!codeToId.has(row.id)) codeToId.set(row.id, codeToId.size + 1);
        if (row.parent_id && row.parent_id !== row.id)
            parentCodes.add(row.parent_id);
    });

    const missingParents = [...parentCodes].filter(
        (code) => !codeToId.has(code),
    );
    if (missingParents.length) {
        throw new Error(
            `存在缺失父节点: ${missingParents.slice(0, 10).join(', ')}`,
        );
    }

    const maxBytes = options.chunkMb * 1024 * 1024;
    const region = new ChunkWriter(
        options.output,
        'region',
        [
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
        ],
        maxBytes,
    );
    const detail = new ChunkWriter(
        options.output,
        'region-detail',
        [
            'region_id',
            'region_code',
            'phone_code',
            'zone',
            'utc',
            'lng',
            'lat',
            'capital',
            'osm_id',
            'geo_names_id',
        ],
        maxBytes,
    );
    const search = new ChunkWriter(
        options.output,
        'region-search',
        ['region_id', 'parent_id', 'search_text'],
        maxBytes,
    );
    const emittedCodes = new Set();

    await readPatchedRows(async (row) => {
        if (emittedCodes.has(row.id)) return;
        emittedCodes.add(row.id);

        const id = codeToId.get(row.id);
        const parentId = row.parent_id ? codeToId.get(row.parent_id) : null;
        const depth = row.parent_path ? JSON.parse(row.parent_path).length : 0;
        const names = [
            row.name_cn,
            row.name_en,
            row.name_other,
            row.name_pinyin,
            row.name_jianpin,
        ];

        await region.write([
            id,
            parentId,
            row.id,
            row.level_type,
            depth,
            parentCodes.has(row.id) ? 1 : 0,
            ...names,
        ]);
        await search.write([
            id,
            parentId,
            [...new Set([...names.filter(Boolean), row.id])].join(' '),
        ]);

        const detailValues = [
            row.region_code,
            row.phone_code,
            row.zone,
            row.utc,
            row.lng,
            row.lat,
            row.capital === '1' ? 1 : 0,
            row.osm_id,
            row.geo_names_id,
        ];
        if (detailValues.some((value) => value !== null && value !== 0)) {
            await detail.write([id, ...detailValues]);
        }
    });

    await Promise.all([region.close(), detail.close(), search.close()]);
    const manifest = {
        generated_at: new Date().toISOString(),
        source_rows: sourceRows,
        regions: codeToId.size,
        duplicates_removed: sourceRows - codeToId.size,
        patch_files: patches.files,
        region: region.manifest(),
        region_detail: detail.manifest(),
        region_search: search.manifest(),
    };
    fs.writeFileSync(
        path.join(options.output, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );

    return manifest;
}

if (require.main === module) {
    build(parseArguments(process.argv.slice(2)))
        .then((manifest) => console.log(JSON.stringify(manifest, null, 2)))
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {
    build,
    decodeValue,
    encodeTsv,
    loadPatches,
    parseInsert,
    parseValues,
};
