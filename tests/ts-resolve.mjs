// テストで TypeScript を読むときに、拡張子なしの import（"./xlsx" など）を ".ts" として探す
import { register } from "node:module";
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + ".ts", ctx);
    throw e;
  }
}`),
  import.meta.url,
);
