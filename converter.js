const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const isStr = (n) => n && ts.isStringLiteral(n);
const isNum = (n) => n && ts.isNumericLiteral(n);
const isArr = (n) => n && ts.isArrayLiteralExpression(n);
const isObj = (n) => n && ts.isObjectLiteralExpression(n);
const isPar = (n) => n && ts.isParenthesizedExpression(n);
const isSqlTagged = (n) =>
  n && ts.isTaggedTemplateExpression(n) && n.tag?.escapedText === "sql";

const snakeToPascal = (s) =>
  (s || "")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

const pascal = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");

const typeMap = {
  uuid: "uuid",
  varchar: "varchar",
  char: "char",
  text: "text",
  bigint: "bigint",
  int: "int",
  integer: "int",
  smallint: "smallint",
  numeric: "numeric",
  decimal: "decimal",
  float: "float",
  double: "double",
  boolean: "boolean",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  date: "date",
  time: "time",
  json: "json",
  jsonb: "jsonb",
  geometry: "geometry",
  geography: "geography",
};

const toType = (x) => typeMap[x] || "text";

const ORDER = [
  "type",
  "enum",
  "precision",
  "scale",
  "length",
  "name",
  "array",
  "primary",
  "generated",
  "unique",
  "nullable",
  "default",
  "createDate",
  "updateDate",
];

const JS_DOC_TYPE_MAP = {
  uuid: "string",
  varchar: "string",
  char: "string",
  text: "string",
  boolean: "boolean",
  int: "number",
  integer: "number",
  smallint: "number",
  bigint: "number",
  numeric: "number",
  decimal: "number",
  float: "number",
  double: "number",
  timestamp: "Date",
  timestamptz: "Date",
  date: "Date",
  time: "Date",
  json: "object",
  jsonb: "object",
  geometry: "object",
  geography: "object",
};

const unwrapSqlTag = (node) => {
  if (!isSqlTagged(node)) return undefined;
  const tx = node.template?.text;
  return /current_timestamp/i.test(tx) ? "CURRENT_TIMESTAMP" : undefined;
};

const overrideDefaultIfSqlTagged = (arg0) =>
  unwrapSqlTag(arg0) ? `'${unwrapSqlTag(arg0)}'` : undefined;

function getColumn(init, name) {
  const col = { type: "text", nullable: true };
  if (!ts.isCallExpression(init)) return col;

  let root = init;
  while (
    ts.isCallExpression(root) &&
    ts.isPropertyAccessExpression(root.expression)
  ) {
    root = root.expression.expression;
  }

  col.type = toType(root.expression?.escapedText);
  const [nameArg, opts] = root.arguments;
  if (isStr(nameArg) && nameArg.text !== name) col.name = nameArg.text;

  if (isObj(opts)) {
    opts.properties.forEach((p) => {
      if (!ts.isPropertyAssignment(p)) return;
      const k = p.name.escapedText;
      const v = p.initializer;
      const set = (cond, val) => cond && (col[k] = val);
      set(k === "length" && isNum(v), +v.text);
      set(k === "precision" && isNum(v), +v.text);
      set(k === "scale" && isNum(v), +v.text);

      if (k === "enum" && isArr(v)) {
        col.enum = v.elements.map((e) =>
          isStr(e) ? e.text : e.name?.escapedText ?? e.getText()
        );
        col.type = "enum";
      }
      if (k === "withTimezone" && v.kind === ts.SyntaxKind.TrueKeyword)
        col.type = "timestamptz";
    });
  }

  let call = init;
  while (call && ts.isCallExpression(call)) {
    const { name: method } = call.expression;
    const arg = call.arguments[0];
    const sqlDefault = overrideDefaultIfSqlTagged(arg);

    switch (method?.escapedText) {
      case "notNull":
        col.nullable = false;
        break;
      case "primaryKey":
        Object.assign(col, { primary: true, nullable: false });
        break;
      case "unique":
        col.unique = true;
        break;
      case "array":
        col.array = true;
        break;
      case "$onUpdate":
        col.updateDate = true;
        break;
      case "default":
        col.default =
          sqlDefault ??
          (arg
            ? isNum(arg)
              ? +arg.text
              : isStr(arg)
              ? `'${arg.text}'`
              : arg.kind === ts.SyntaxKind.TrueKeyword
              ? true
              : arg.kind === ts.SyntaxKind.FalseKeyword
              ? false
              : undefined
            : true);
        break;
      case "defaultRandom":
        Object.assign(col, {
          generated: "uuid",
          type: "uuid",
          nullable: false,
        });
        break;
      case "defaultNow":
        if (name !== "createdAt") col.default = true;
        break;
      case "references":
        if (ts.isArrowFunction(arg)) {
          const body = arg.body;
          if (ts.isPropertyAccessExpression(body))
            col.referencesVar = body.expression.escapedText;
        }
        if (isObj(call.arguments[1])) {
          call.arguments[1].properties.forEach((p) => {
            if (!ts.isPropertyAssignment(p)) return;
            const k = p.name.escapedText;
            const v = p.initializer;
            if (k === "onDelete" && isStr(v)) col.onDelete = v.text;
            if (k === "onUpdate" && isStr(v)) col.onUpdate = v.text;
            if (k === "cascade" && v.kind === ts.SyntaxKind.TrueKeyword)
              col.cascade = true;
          });
        }
        break;
    }
    call = call.expression.expression;
  }

  if (name === "createdAt")
    Object.assign(col, { createDate: true, nullable: false });
  if (name === "updatedAt") col.updateDate = true;
  return col;
}

const printColumnField = (k, v, cfg) => {
  if (k === "enum") {
    return cfg.type === "enum"
      ? `        enum: [${v.map((e) => `'${e}'`).join(", ")}],`
      : "";
  }

  if (typeof v === "string" && !/^'.*'$/.test(v)) {
    return `        ${k}: '${v}',`;
  }

  return `        ${k}: ${v},`;
};

function printRelation(r) {
  const out = [];
  out.push(`      ${r.localName}: {`);
  out.push(`        target: '${r.toEntity}',`);
  out.push(`        type: '${r.relType}',`);
  if (r.inverseSide) out.push(`        inverseSide: '${r.inverseSide}',`);

  if (r.relType !== "one-to-many" && r.joinColumnName) {
    out.push(`        joinColumn: { name: '${r.joinColumnName}' },`);
  }

  if (r.relType === "many-to-many" && r.isOwner) {
    out.push("        joinTable: true,");
  }

  if (r.relType === "many-to-one" || r.relType === "one-to-one") {
    if (r.onDelete) out.push(`        onDelete: '${r.onDelete}',`);
    if (r.onUpdate) out.push(`        onUpdate: '${r.onUpdate}',`);
  }

  if (r.cascade) out.push(`        cascade: true,`);
  out.push("      },");
  return out.join("\n");
}

function convertSchemas(filesInput) {
  const var2entity = {};
  const entity2file = {};
  const entityData = {};
  const relationStubs = [];
  const fileOutputMap = {};

  filesInput.forEach(({ fileName, content }) => {
    const src = ts.createSourceFile(
      fileName,
      content,
      ts.ScriptTarget.Latest,
      true
    );
    src.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;
      n.declarationList.declarations.forEach((d) => {
        if (
          d.initializer &&
          ts.isCallExpression(d.initializer) &&
          d.initializer.expression.getText() === "pgTable"
        ) {
          const [tblArg] = d.initializer.arguments;
          const ent = isStr(tblArg)
            ? snakeToPascal(tblArg.text)
            : pascal(d.name.escapedText);
          var2entity[d.name.escapedText] = ent;
          entity2file[ent] = fileName;
        }
      });
    });
  });

  filesInput.forEach(({ fileName, content }) => {
    const src = ts.createSourceFile(
      fileName,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    src.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;

      n.declarationList.declarations.forEach((d) => {
        const init = d.initializer;
        if (!init || !ts.isCallExpression(init)) return;

        if (init.expression.escapedText === "pgTable") {
          const tableVar = d.name.escapedText;
          const tblStr = init.arguments[0];
          const tableName = isStr(tblStr) ? tblStr.text : null;
          const columns = {};

          const entName = var2entity[tableVar];
          entityData[entName] ??= {
            tableName,
            columns,
            relations: [],
            indices: [],
          };

          const colObj = init.arguments[1];
          if (isObj(colObj)) {
            colObj.properties.forEach((p) => {
              if (!ts.isPropertyAssignment(p)) return;
              columns[p.name.escapedText] = getColumn(
                p.initializer,
                p.name.escapedText
              );
            });
          }

          const pkFactory = init.arguments[2];
          if (pkFactory && ts.isArrowFunction(pkFactory)) {
            const pkArr = pkFactory.body;
            if (isArr(pkArr)) {
              pkArr.elements.forEach((e) => {
                if (!ts.isCallExpression(e)) return;

                if (e.expression.escapedText === "primaryKey") {
                  const [pkObj] = e.arguments;
                  if (isObj(pkObj)) {
                    pkObj.properties.forEach((p) => {
                      if (
                        ts.isPropertyAssignment(p) &&
                        p.name.escapedText === "columns" &&
                        isArr(p.initializer)
                      ) {
                        p.initializer.elements.forEach((colEl) => {
                          const colName = colEl.name?.escapedText;
                          if (colName && columns[colName]) {
                            Object.assign(columns[colName], {
                              primary: true,
                              nullable: false,
                            });
                          }
                        });
                      }
                    });
                  }
                  return;
                }

                const root = (() => {
                  let c = e;
                  while (
                    ts.isCallExpression(c) &&
                    ts.isPropertyAccessExpression(c.expression) &&
                    c.expression.name.escapedText === "on"
                  ) {
                    c = c.expression.expression;
                  }
                  return c;
                })();

                if (
                  ts.isCallExpression(root) &&
                  (root.expression.escapedText === "index" ||
                    root.expression.escapedText === "uniqueIndex")
                ) {
                  const idxName = root.arguments[0]?.text;
                  const unique = root.expression.escapedText === "uniqueIndex";
                  const cols = [];
                  let c = e;
                  while (
                    ts.isCallExpression(c) &&
                    ts.isPropertyAccessExpression(c.expression) &&
                    c.expression.name.escapedText === "on"
                  ) {
                    const arg = c.arguments[0];
                    if (ts.isPropertyAccessExpression(arg))
                      cols.push(arg.name.escapedText);
                    c = c.expression.expression;
                  }
                  entityData[entName].indices.push({
                    name: idxName,
                    columns: cols,
                    unique,
                  });
                }
              });
            }
          }
        }

        if (init.expression.escapedText === "relations") {
          const fromVar = init.arguments[0]?.escapedText;
          const fn = init.arguments[1];
          if (!ts.isArrowFunction(fn)) return;

          let body = fn.body;
          if (isPar(body)) body = body.expression;
          if (!isObj(body)) return;

          body.properties.forEach((rp) => {
            if (
              !ts.isPropertyAssignment(rp) ||
              !ts.isCallExpression(rp.initializer)
            )
              return;

            const localName = rp.name.escapedText;
            const call = rp.initializer;
            const kind = call.expression.escapedText;
            const targVar = call.arguments[0]?.escapedText;
            if (!targVar) return;

            let relType;
            if (kind === "many") {
              relType = "one-to-many";
            } else if (kind === "one") {
              const opts = call.arguments[1];
              const hasFields =
                isObj(opts) &&
                opts.properties.some(
                  (p) =>
                    ts.isPropertyAssignment(p) &&
                    p.name.escapedText === "fields" &&
                    isArr(p.initializer)
                );

              relType = hasFields ? "many-to-one" : "one-to-one";
            } else if (kind === "oneToOne") {
              relType = "one-to-one";
            } else {
              relType = "many-to-one";
            }

            const relation = {
              fromEntity: var2entity[fromVar],
              fromVar,
              localName,
              toEntity: var2entity[targVar] || pascal(targVar || ""),
              toVar: targVar,
              relType,
              inverseSide: null,
              origKind: kind,
            };

            let fkPropName = null;
            const opts = call.arguments[1];
            if (isObj(opts)) {
              opts.properties.forEach((p) => {
                if (!ts.isPropertyAssignment(p)) return;
                const k = p.name.escapedText;
                const v = p.initializer;
                if (k === "relationName" && isStr(v))
                  relation.customName = v.text;
                else if (k === "onDelete" && isStr(v))
                  relation.onDelete = v.text;
                if (k === "onUpdate" && isStr(v)) relation.onUpdate = v.text;
                if (k === "cascade" && v.kind === ts.SyntaxKind.TrueKeyword)
                  relation.cascade = true;
                if (k === "fields" && isArr(v) && v.elements.length) {
                  const el = v.elements[0];
                  if (ts.isPropertyAccessExpression(el))
                    fkPropName = el.name.escapedText;
                }
              });
            }

            const toSnake = (s) =>
              s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
            let fk = fkPropName;
            if (!fk) {
              const targetCols = entityData[relation.toEntity]?.columns || {};
              for (const [colName, col] of Object.entries(targetCols)) {
                if (col.referencesVar === relation.fromVar) {
                  fk = colName;
                  break;
                }
              }
            }
            if (fk) {
              relation.joinColumnName =
                entityData[relation.fromEntity]?.columns?.[fk]?.name ||
                entityData[relation.toEntity]?.columns?.[fk]?.name ||
                toSnake(fk);
            }

            const col = entityData[relation.fromEntity]?.columns?.[fk];
            if (col) {
              if (col.onDelete && !relation.onDelete)
                relation.onDelete = col.onDelete;
              if (col.onUpdate && !relation.onUpdate)
                relation.onUpdate = col.onUpdate;
              if (col.cascade && !relation.cascade)
                relation.cascade = col.cascade;
            }

            relationStubs.push(relation);
          });
        }
      });
    });
  });

  relationStubs.forEach((r1) => {
    if (r1.inverseSide) return;
    const r2 = relationStubs.find(
      (x) =>
        x.fromEntity === r1.toEntity &&
        x.toEntity === r1.fromEntity &&
        !x.inverseSide
    );
    if (r2) {
      r1.inverseSide = r2.localName;
      r2.inverseSide = r1.localName;

      if (r1.origKind === "many" && r2.origKind === "many") {
        r1.relType = r2.relType = "many-to-many";
        r1.isOwner = true;
      } else if (r1.origKind === "one" && r2.origKind === "one") {
        r1.relType = r2.relType = "one-to-one";
        if (r1.joinColumnName) r1.isOwner = true;
        else if (r2.joinColumnName) r2.isOwner = true;
      }
    }
  });

  relationStubs.forEach((r) => {
    const rels = entityData[r.fromEntity].relations;
    if (!rels.some((x) => x.localName === r.localName)) rels.push(r);
  });

  Object.entries(entityData).forEach(([entity, data]) => {
    const out = [];
    out.push(`${entity}: new EntitySchema({`);
    out.push(`    name: '${entity}',`);
    out.push(`    tableName: '${data.tableName}',`);
    out.push("    columns: {");
    Object.entries(data.columns).forEach(([col, cfg]) => {
      out.push(`      ${col}: {`);
      ORDER.forEach((k) => {
        if (k === "length" && cfg.type === "enum") return;
        if (cfg[k] === undefined) return;
        const line = printColumnField(k, cfg[k], cfg);
        if (line) out.push(line);
      });
      out.push("      },");
    });
    out.push("    },");

    if (data.relations.length) {
      out.push("    relations: {");
      data.relations.forEach((r) => out.push(printRelation(r)));
      out.push("    },");
    }

    if (data.indices?.length) {
      out.push("    indices: [");
      data.indices.forEach((ix) => {
        out.push(
          `      { name: '${ix.name}', columns: [${ix.columns
            .map((c) => `'${c}'`)
            .join(", ")}]${ix.unique ? ", unique: true" : ""} },`
        );
      });
      out.push("    ],");
    }

    out.push("  }),");

    const tsFile = entity2file[entity];
    fileOutputMap[tsFile] = fileOutputMap[tsFile] || [];
    fileOutputMap[tsFile].push(out.join("\n").trim());
  });

  const filesOutput = {};
  for (const [tsFile, schemas] of Object.entries(fileOutputMap)) {
    const outFile = tsFile.replace(/\.ts$/, ".js");
    filesOutput[outFile] = [
      "const typeorm = require('typeorm');",
      "const { EntitySchema } = typeorm;",
      "",
      ...Object.entries(entityData)
        .filter(([entity]) =>
          fileOutputMap[tsFile]?.some((s) => s.includes(`name: '${entity}'`))
        )
        .map(([entity, data]) => {
          const fields = Object.entries(data.columns)
            .map(([k, v]) => {
              const jsType = v.enum
                ? `'${v.enum.join("' | '")}'`
                : JS_DOC_TYPE_MAP[v.type] || "any";
              return ` * @property {${jsType}} ${k}`;
            })
            .join("\n");
          return `/**\n * @typedef {Object} ${entity}\n${fields}\n */`;
        }),
      "",
      "module.exports = {",
      schemas
        .map((s) => {
          const entityMatch = s.match(/^(\w+):/);
          const entityName = entityMatch?.[1];
          return entityName
            ? `  /** @type {typeorm.EntitySchema<${entityName}>} */\n  ${s.replace(
                /,$/,
                ""
              )}`
            : "  " + s.replace(/,$/, "");
        })
        .join(",\n"),
      "};",
    ].join("\n");
  }
  return filesOutput;
}

module.exports = {
  convertSchemas,
};
