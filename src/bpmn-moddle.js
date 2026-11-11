/**
 * `fs:` BPMN 扩展的共享契约（服务端与浏览器共用）。
 *
 * 本文件只放命名空间常量与 moddle 描述符：不依赖 Node、DOM 或任何解析器，
 * 也不执行解析。服务端用它构造 moddle 实例（src/bpmn-parse.js）；浏览器
 * chunk 用同一份描述符创建/读取扩展元素，避免两边字段形状各自漂移。
 *
 * 描述符写法按实测（docs/plan/0.13-研究-bpmn-io.md §3）：
 * - `superClass: ['Element']`：用 `extends: ['bpmn:BaseElement']` 实测解析不到
 *   `extensionElements` 里的子元素；
 * - `xml.tagAlias: 'lowerCase'`：`fs:Node` → `<fs:node>`、`fs:MaxRounds` → `<fs:maxRounds>`。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-moddle
 */

/** 我们自己的扩展命名空间：`fs:`（Flow Studio）。 */
export const FS_NAMESPACE = 'http://feiyueve.dev/schema/bpmn/fs/1.0'
/** 官方 BPMN 2.0 MODEL 命名空间。 */
export const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL'
/** 官方 BPMN 2.0 DI 命名空间（转换器生成图时用）。 */
export const BPMNDI_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/DI'
/** Camunda Zeebe 扩展命名空间。 */
export const ZEEBE_NAMESPACE = 'http://camunda.org/schema/zeebe/1.0'

/**
 * `fs:` 的 moddle 描述符。
 *
 * 写法按实测（docs/plan/0.13-研究-bpmn-engine.md §6）：
 * - `superClass: ['Element']`——用 `extends: ['bpmn:BaseElement']` 实测解析不到
 *   `extensionElements` 里的子元素；
 * - `xml.tagAlias: 'lowerCase'`——`fs:Node` → `<fs:node>`、`fs:MaxRounds` → `<fs:maxRounds>`。
 *
 * 字段说明：
 * - `<fs:node nodeType="agent|http" provider="…" adapter="…" skills="a,b" hooks="x,y">`
 * - 子元素：`<fs:prompt>` / `<fs:roleCard>` / `<fs:note>` / `<fs:team>` / `<fs:http>`；
 * - `<fs:team mode="fanout|none"><fs:member id="…" role="…" skills="…"><fs:prompt>…</fs:prompt></fs:member></fs:team>`
 * - `<fs:maxRounds>2</fs:maxRounds>`：挂在回退 `sequenceFlow` 的 `extensionElements` 上，
 *   记录旧模型里目标节点的打回上限。
 */
export const FS_MODDLE_PACKAGE = {
  name: 'fs',
  prefix: 'fs',
  uri: FS_NAMESPACE,
  xml: { tagAlias: 'lowerCase' },
  associations: [],
  types: [
    {
      name: 'Node',
      superClass: ['Element'],
      properties: [
        { name: 'nodeType', type: 'String', isAttr: true },
        { name: 'provider', type: 'String', isAttr: true },
        { name: 'adapter', type: 'String', isAttr: true },
        { name: 'skills', type: 'String', isAttr: true },
        { name: 'hooks', type: 'String', isAttr: true },
        { name: 'prompt', type: 'String' },
        { name: 'roleCard', type: 'String' },
        { name: 'note', type: 'String' },
        { name: 'model', type: 'String', isAttr: true },
        { name: 'agentPreset', type: 'String', isAttr: true },
        { name: 'team', type: 'Team' },
        { name: 'http', type: 'Http' },
        { name: 'executor', type: 'Executor' },
        { name: 'output', type: 'Output', isMany: true },
        { name: 'check', type: 'Check' },
        { name: 'legacy', type: 'Legacy' },
      ],
    },
    {
      name: 'Team',
      superClass: ['Element'],
      properties: [
        { name: 'mode', type: 'String', isAttr: true },
        { name: 'member', type: 'Member', isMany: true },
      ],
    },
    {
      name: 'Member',
      superClass: ['Element'],
      properties: [
        { name: 'id', type: 'String', isAttr: true },
        { name: 'role', type: 'String', isAttr: true },
        { name: 'skills', type: 'String', isAttr: true },
        { name: 'prompt', type: 'String' },
      ],
    },
    {
      name: 'Http',
      superClass: ['Element'],
      properties: [
        { name: 'method', type: 'String', isAttr: true },
        { name: 'url', type: 'String', isAttr: true },
        { name: 'headers', type: 'String', isAttr: true },
        { name: 'timeoutMs', type: 'Integer', isAttr: true },
        { name: 'retries', type: 'Integer', isAttr: true },
        { name: 'body', type: 'String' },
        { name: 'inputMapping', type: 'String' },
        { name: 'outputMapping', type: 'String' },
      ],
    },
    {
      name: 'Executor',
      superClass: ['Element'],
      properties: [
        { name: 'kind', type: 'String', isAttr: true },
        { name: 'command', type: 'String', isAttr: true },
        { name: 'cwd', type: 'String', isAttr: true },
        { name: 'env', type: 'String', isAttr: true },
        { name: 'timeoutMs', type: 'Integer', isAttr: true },
        { name: 'schemaPath', type: 'String', isAttr: true },
      ],
    },
    {
      name: 'Output',
      superClass: ['Element'],
      properties: [
        { name: 'name', type: 'String', isAttr: true },
        { name: 'kind', type: 'String', isAttr: true },
        { name: 'required', type: 'Boolean', isAttr: true },
        // 不是标准的 {name,kind,required} 形状时，用 JSON 原样留档。
        { name: 'json', type: 'String', isAttr: true },
        { name: 'text', type: 'String', isBody: true },
      ],
    },
    {
      name: 'Check',
      superClass: ['Element'],
      properties: [{ name: 'json', type: 'String', isBody: true }],
    },
    {
      name: 'Legacy',
      superClass: ['Element'],
      properties: [{ name: 'json', type: 'String', isBody: true }],
    },
    {
      name: 'Note',
      superClass: ['Element'],
      properties: [{ name: 'text', type: 'String', isBody: true }],
    },
    {
      name: 'MaxRounds',
      superClass: ['Element'],
      properties: [{ name: 'value', type: 'Integer', isBody: true }],
    },
  ],
}

/**
 * 返回一份新的 `fs:` 描述符副本。
 *
 * bpmn-moddle 会在构造时**就地**给自己的类型加命名空间前缀（`nodeType` →
 * `fs:nodeType`）。共享常量一旦被改脏，第二次实例化、测试断言或浏览器端按
 * 字段名查描述符都会看到带前缀的名字；所以每次构造 moddle 实例都拿一份新副本，
 * 让 `FS_MODDLE_PACKAGE` 始终是只读契约。
 */
export function createFsModdlePackage() {
  return JSON.parse(JSON.stringify(FS_MODDLE_PACKAGE))
}
