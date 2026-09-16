/** 官方编号优先：按名称与行政层级匹配身份，整批换码可处理编号互换。 */
export function planRemoteCodes(
    existing: any[],
    remote: any[],
    countryId: number,
) {
    const level = (n: number) => (n < 500 ? 1 : n < 600 ? 2 : n < 700 ? 3 : 4);
    const byCode = new Map(existing.map((r) => [r.code, r]));
    const localNames = new Map<string, any[]>();
    const remoteNames = new Map<string, any[]>();
    for (const r of existing) {
        const key = `${level(r.level_type)}:${r.name_cn}`;
        if (!localNames.has(key)) localNames.set(key, []);
        localNames.get(key).push(r);
    }
    for (const r of remote) {
        const key = `${r.level}:${r.name}`;
        if (!remoteNames.has(key)) remoteNames.set(key, []);
        remoteNames.get(key).push(r);
    }
    const used = new Set<number>();
    const assigned = new Map<string, any>();
    // 父节点先于子节点，跨父级时只采用地市/省内双向唯一名称匹配。
    for (const row of remote) {
        const key = `${row.level}:${row.name}`;
        const all = (localNames.get(key) || []).filter((r) => !used.has(r.id));
        const parentId = row.parent
            ? assigned.get(row.parent)?.id ?? byCode.get(row.parent)?.id
            : countryId;
        let candidates = all.filter((r) => r.parent_id === parentId);
        if (candidates.length > 1) {
            const exact = candidates.filter((r) => r.code === row.code);
            if (exact.length === 1) candidates = exact;
        }
        if (!candidates.length) {
            for (const length of [4, 2]) {
                const scope = row.code.slice(0, length);
                const localScope = all.filter(
                    (r) => r.code.slice(0, length) === scope,
                );
                const remoteScope = (remoteNames.get(key) || []).filter(
                    (r) => r.code.slice(0, length) === scope,
                );
                if (localScope.length === 1 && remoteScope.length === 1) {
                    candidates = localScope;
                    break;
                }
            }
        }
        if (candidates.length === 1) {
            assigned.set(row.code, candidates[0]);
            used.add(candidates[0].id);
        }
    }
    // 同一父级下，乡/镇/地区/街道名称后缀变化，仅对双向唯一的剩余项匹配。
    const stem = (name: string) =>
        name.replace(/(?:街道(?:办事处)?|地区(?:办事处)?|乡|镇|苏木)$/, '');
    for (const row of remote.filter(
        (r) => r.level === 4 && !assigned.has(r.code),
    )) {
        const parentId =
            assigned.get(row.parent)?.id ?? byCode.get(row.parent)?.id;
        const candidates = existing.filter(
            (r) =>
                !used.has(r.id) &&
                level(r.level_type) === 4 &&
                r.parent_id === parentId &&
                stem(r.name_cn) === stem(row.name),
        );
        const alternatives = remote.filter(
            (r) =>
                r.level === 4 &&
                !assigned.has(r.code) &&
                r.parent === row.parent &&
                stem(r.name) === stem(row.name),
        );
        if (candidates.length === 1 && alternatives.length === 1) {
            assigned.set(row.code, candidates[0]);
            used.add(candidates[0].id);
        }
    }
    // 名称匹配完成后，同编号、同父级、同层级的剩余项按官方更名处理。
    for (const row of remote.filter((r) => !assigned.has(r.code))) {
        const old = byCode.get(row.code);
        const parentId = row.parent
            ? assigned.get(row.parent)?.id ?? byCode.get(row.parent)?.id
            : countryId;
        if (
            old &&
            !used.has(old.id) &&
            old.parent_id === parentId &&
            level(old.level_type) === row.level
        ) {
            assigned.set(row.code, old);
            used.add(old.id);
        }
    }
    const codes = new Set(remote.map((r) => r.code));
    const targets = new Map<number, string>();
    for (const [code, row] of assigned) targets.set(row.id, code);
    const reserved = new Set([...existing.map((r) => r.code), ...codes]);
    const localAliases: any[] = [];
    for (const r of existing) {
        if (!used.has(r.id) && codes.has(r.code)) {
            // 对应关系不明确时保留本地实体，不能占用官方编号；不伪造数字行政代码。
            const alias = `local:${r.id}:${r.code}`;
            if (alias.length > 32 || reserved.has(alias))
                throw new Error(`本地保留编号冲突: ${r.code}`);
            targets.set(r.id, alias);
            reserved.add(alias);
            localAliases.push({
                id: r.id,
                name: r.name_cn,
                code: r.code,
                target: alias,
            });
        }
    }
    const codeMaps = existing
        .filter((r) => targets.has(r.id) && targets.get(r.id) !== r.code)
        .map((r) => ({ id: r.id, code: r.code, target: targets.get(r.id) }));
    if (new Set(codeMaps.map((r) => r.target)).size !== codeMaps.length)
        throw new Error('官方编号映射出现重复目标');
    return {
        codeMaps,
        localAliases,
        keepIds: new Set(
            existing.filter((r) => !used.has(r.id)).map((r) => r.id),
        ),
        matched: assigned.size,
        added: remote.length - assigned.size,
    };
}
