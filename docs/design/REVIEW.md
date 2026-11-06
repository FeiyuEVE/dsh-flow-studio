# 设计审核报告

## 结论：驳回

宿主 token 族级事实有误，成员身份色绕开硬约束，核心几何与交互仍有未仲裁冲突；文字对比度和质量结论也存在可复现错误，当前不能作为可直接实现、验收的唯一设计依据。

审核范围：任务书、总案、01–04 分册、现状客户端及共用模型；宿主事实仅以指定安装版主题源码为准。本次只产出本报告，没有改写设计与实现。“部分回答”评价设计覆盖，不代表相关功能已经实现；总案已明确把运行与指标接入延后。

严重级别：BLOCKER＝违反硬约束或使核心规格无法唯一实现；MAJOR＝误导监督判断、造成数据/操作问题或需明显返工；MINOR＝不阻止主体实现的改进。没有把未经浏览器实测的性能推测写成已发生故障。

| 审核维度 | 结论 | 最高严重级别 | 证据位置 |
|---|---|---|---|
| 事实核验 | 36 个具体变量均存在；圆角集合、最小字号、最大字重三项宿主断言错误 | BLOCKER | B01、逐条核验 §1 |
| 内部一致性 | §6解决部分基础冲突，但团队几何、选中、展开、输入等仍不唯一 | BLOCKER | B03、逐条核验 §2 |
| 需求覆盖 | 六问均有涉及，指标位置明确，但完成/质量/规范证据口径不足 | MAJOR | M01–M04、逐条核验 §3 |
| 可实现性 | React手写、零第三方库可行；成本主要在几何、编辑事务、数据契约 | MAJOR | 逐条核验 §4；现有客户端46,512字节 |
| 可用性 | 日常监督存在看不清、找不到、操作习惯改变、结论不可信问题 | MAJOR | 逐条核验 §5 |
| 视觉风险 | 同白分层未形成统一规格；品牌中性色已识别；R1只够图形，不够普通小字 | BLOCKER | B04、逐条核验 §6 |

## 阻断级问题（BLOCKER）

| 编号 | 位置（文件:节） | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| B01 | [02:§0.3、§2.1](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L46>) | 宿主token事实未核实完整：圆角漏20px；“宿主最小字号13”“宿主最大字重500”均不真实。按本次硬指标直接阻断。 | 第46行称“只有4/8/12/16/28”；第73行称宿主最小档13；第82行称400/500与宿主最大字重一致。宿主1407行实际有`--dsw-radius-xl:20px`；1425行有`--dsw-font-xxs-12:12px/18px`、`--dsw-font-xxxs-11:11px/14px`、markdown标题700、xl-24字重600。 | 修正事实及论证。产品可以自行选12px地板和400/500，但不能把产品选择写成宿主不存在其他档位。 |
| B02 | [03:§4.4](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L328>)；[02:§1](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L56>) | 自设成员身份色12个hex，视觉分册自行宣称“登记在案的豁免”，违反宿主token硬约束及总案。 | 03第332–337行两组六色如`#7C6BC4`/`#9D8FE0`；02第56行豁免。对照[任务书:22](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN-BRIEF.md#L22>)及[总案:53、145](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L53>)，没有授权。 | 删除豁免和自设颜色；用已有顺序、首字、方圆形识别身份。若仍需颜色，仅用允许的宿主变量并验证状态不混淆。 |
| B03 | [总案:§3、§5、§6](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L53>)；[02:§3.1](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L234>)；[03:§2.3](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L145>) | 仲裁未收敛成唯一核心规格：团队卡高度/成员展示、运行展开是否移动结构、选中色、画布底色均冲突。 | 总案100行团队116高默认成员行；02第239–240行96默认、144展开才有成员行；03第155、168行96默认、展开`72+26×n`。总案110行冻结结构，03第355行展开重排整行/下移航道。总案55行选中中性，02第359行business蓝；总案54行亮色底混3.5%，02第355行直接bg-base。§6均没裁决。 | 在总案给唯一结果，明确旧段落废止。团队计数要明确含不含主管，定义实际矩形、锚点；运行冻结时给不移动结构的成员查看路径。 |
| B04 | [02:§4.2–§4.4](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L364>) | 把图形对比度门槛套到普通文字：R1成功/警告小字及tertiary信息文字仍不达标，却打勾称合法；自身CI口径会失败。 | sRGB浮点复算：success R1对白**4.1395:1**、warn R1 **3.9350:1**、tertiary **3.7056:1**。02第382–383行把R1用于状态小字，368行称tertiary为信息下限；404行又要求文字≥4.5。business原色4.2349也不够普通小字。 | 分开图形色与文字色。状态小字用达标文字token或单独混色配方；按白卡、tint、chip真实背景各验一次，不用图形≥3的勾覆盖文字。 |

## 重要问题（MAJOR）

| 编号 | 问题与影响 | 可复核证据 | 修法 |
|---|---|---|---|
| M01 | 任务完成度实际只是阶段通过比例，没映射用户验收条目；返工后旧通过是否失效不清，可能把过期测试/审查算完成。 | [04:145](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L145>)定义通过阶段/总阶段；[03:315](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L315>)回退后中间节点仍passed；任务书33行要求任务完成度。 | 该数标“阶段进度”；另定义验收条目通过/总数及证据，规定返工版本、旧结果失效及跳过阶段分母。 |
| M02 | 质量评分有确定性假阳性，把返工一次也称“一次通过”。 | [04:295–297](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L295>)“优”允许返工1次，文案却一次通过；“良”只查完成100%、P0=0、返工≤2。输入完成100%、返工1、P0=0、采纳率0%、测试50%、P1=20，按表仍输出“良”。 | 用反例验评分；必要质量证据失败/缺失不输出绿灯，分开未检测与通过，修正文案。 |
| M03 | 编码规范指标只有展示位置，没有数据源、规则集、状态与分母；缺陷采纳也没区分修复/复验。 | [04:254](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L254>)只写两个指标块；[04:222、294](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L222>)缺陷只给是否采纳，却用P0决定返工。四分册“规范”检索未给检测工具/规则版本/通过总数/证据链接。 | 定义规范检查来源、规则版本、通过/不通过/未检测/不适用及证据；缺陷分发现总数和当前未解决数，采纳不等于修复。 |
| M04 | skill采纳率混用是否加载与次数；token三段不保证互斥；缓存“无成本”无依据。 | [04:148、252](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L148>)分别写实际加载/声明总数、加载几次/声明几次；返工或多个子agent重复加载可能超分母。[04:174、191–195](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L174>)输入/输出/缓存三段，没定义缓存是否含输入，直接称“无成本”。 | 改为按唯一skill去重的加载覆盖率，次数另列；定义用量字段、父子及轮次归属、互斥关系；无计费证据不作成本承诺。 |
| M05 | 运行展示没有最小数据契约与切页恢复定义。新增流程字段在当前保存链上会被丢弃。 | [api:36–44](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/api.js#L36>)只有流程/skill请求；[模型:210–259](</home/feiyueve/文档/dsh/dsh-flow-studio/src/model.js#L210>)白名单不保留condition、成员model等新字段；[04:329](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L329>)只提SSE/轮询，无run/attempt/member标识、时间戳、去重重连。 | 可按总案延后引擎，但先定标识、状态来源、时间、恢复、历史结果与新增字段持久化。不能把预留位置当作完整接入方案。 |
| M06 | 离线“已存本地副本/自动同步”承诺没有实现或设计保障，切页可能丢改动。 | [01:296–301](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L296>)明确承诺；[任务书:25](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN-BRIEF.md#L25>)切页卸载。[page:115–118、176–181](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/page.js#L115>)失败只改React状态，debounce清理取消timer，无本地存储；123–132行保存失败仍继续换流程。 | 本地草稿、卸载恢复、重连覆盖冲突必须成为该文案前提；未实现前不得承诺已存本地。 |
| M07 | 全览数学用了两套世界宽/边距；30节点长链在25%下限下无法全纳。 | [02:168](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L168>)宽1852是压缩端点间距；[03:34、53](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L34>)八列统一260，则右缘`7×260+120=1940`。1396宽、48边距若为屏幕px，fit=`1300/1940=67.01%`；若为世界边距则`1396/2036=68.57%`，均低70%完整标题档。30阶段串行宽`29×260+208=7748`，fit约16.78%。 | 统一端点坐标、边距坐标系和全览场景；定义长链导航/分段策略，不能假定30节点tidy后必1852宽。 |
| M08 | 键盘连线及单指针拖拽替代没有可执行操作链。 | [总案:154](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L154>)要求键盘连线；[01:225–244](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L225>)全键表没有选源/选目标；131–139行右键菜单也没有连接到/移到。方向键不能作为纯指针移动的替代。 | 补点击源→点击目标或检查器选目标路径，移动提供可点按入口；分别验键盘和单指针，不能混用WCAG标准。 |
| M09 | 裸滚轮的已定产品决策被改；吸附修饰键也冲突，影响每天使用的肌肉记忆。 | [任务书:69](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN-BRIEF.md#L69>)滚轮缩放；[01:187、191](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L187>)改裸滚轮纵移、Ctrl缩放/Ctrl绕过吸附；[02:117](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L117>)又为Alt绕过。现状[canvas:121–134](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L121>)是裸滚轮缩放。 | 对硬决策变更单独裁决，区分鼠标滚轮、触控板滚动、pinch；形成唯一输入状态表。 |
| M10 | 航道只证明四边单行模板，没覆盖同列分支、手拖多行、五个同目标端口及标签碰撞。 | [03:84–98、138–143](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L84>)每节点只有4槽，总边数>6才退化，恰好5条同入一个节点没有第5槽；按列排序也没同列tie-break。[02:277](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L277>)另改中心扇出。 | 保留简单航道，补超额端口、同列/多行、标签放不下的确定性降级；不承诺任意手排自动零碰撞。 |
| M11 | 低缩放全部文字隐藏、角标变色点，与非颜色双编码及60%验收矛盾。 | [02:198–199](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L198>)50–69%紧凑、<50%全隐文字+角标色点；[总案:57](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L57>)阈值却60/45%。总案113、150行要求双非颜色通道、60%可识别打回。 | 统一LOD，保留状态形状、方向与可聚焦名称；用灰度及60%图验证，不能把色点称为完整双编码。 |

## 建议（MINOR）

| 编号 | 建议 | 可复核依据 |
|---|---|---|
| N01 | 28px按钮按桌面鼠标取舍写明，触控另定命中要求；删掉“44px会撑两排”的绝对论断。 | [01:108–111](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L108>)顶栏48高，44高按钮本身仍能单行，横向是否拥挤另论。 |
| N02 | 图标明确用少量手写SVG，说明示例中的emoji仅为示意还是实际字符。 | [01:108](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L108>)要求SVG；[04:161、184](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L161>)有拼图/警告等符号，实际emoji会随平台改变彩色外观与尺寸。 |
| N03 | 将“Chrome中文默认最小12px”降为需记录环境验证的假设，产品12px地板可保留。 | [02:87、98–100](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L87>)没有版本/语言设置实测记录，又主动接受transform后9.8px标题；CSS字号、用户最小字号与缩放后屏幕尺寸应分开。 |
| N04 | 撤销验证聚焦事务边界，不为菜单皮肤写镜像测试。 | [01:208–217](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L208>)粒度已定义，是优点；[page:88–99](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/page.js#L88>)及[canvas:154](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L154>)每变化整流回写，需验证拖放一次、失焦一次、跨流程隔离。 |

## 逐条核验记录

### 1 token 核验表（变量名 / 文档声称 / 源码实际 / 判定）

先完成此项，再通读其余设计。提取六份输入中的所有具体`--dsw-*`名，补全02 §4.1省略的alias前缀与scrollbar-hover-l2，共**36个具体引用**。通配前缀不当成一个不存在变量；源码内var链按亮/暗body规则递归解析。

唯一事实源为[宿主client.js](</usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js#L1413>)。下表亮/暗顺序固定；alpha百分比按文档取整看待。字体按默认栈与表达式核验，不宣称用户设置固定不变。

三类结果：

- **不存在：0项**，限上述36个具体引用。04的`state-success`/`state-warn`等未带完整前缀者当语义缩写，代码应映射到实际的`*-primary`，不能直接拼接缩写。
- **存在但取值/宿主族断言与文档不符：3组**，圆角集合、最小字号、最大字重；末尾另列实际声明反证。不能误报为已引用的变量不存在。
- **正确：36个具体变量**。R1对比度是用途/判定错误，见B04；03把brand当蓝已被总案§6纠正，不重复当未解决的假token。

| 变量名 | 文档声称 | 源码实际（亮 / 暗，或表达式） | 判定 |
|---|---|---|---|
| `--dsw-alias-bg-base` | 02:326，白/#151517 | 1413行：#fff/#151517 | 正确 |
| `--dsw-alias-bg-layer-1` | 02:327，白/#232324 | 1413行：#fff/#232324 | 正确 |
| `--dsw-alias-bg-layer-2` | 02:328，白/#2c2c2e | 1413行：#fff/#2c2c2e | 正确 |
| `--dsw-alias-bg-layer-3` | 02:329，白/#353638 | 1413行：#fff/#353638 | 正确（补前缀） |
| `--dsw-alias-border-l1` | 02:330，黑4%/白6% | 1413行：#0000000a/#ffffff0f | 正确（取整） |
| `--dsw-alias-border-l2` | 02:331，黑10%/白12% | 1413行：#0000001a/#ffffff1f | 正确（取整） |
| `--dsw-alias-border-l3` | 02:332，黑12%/白16% | 1413行：#0000001f/#ffffff29 | 正确（取整） |
| `--dsw-alias-border-l4` | 02:333，黑16%/白20% | 1413行：#00000029/#fff3 | 正确（取整） |
| `--dsw-alias-label-primary` | 02:334，#0f1115/#f9fafb | 1413行：#0f1115/#f9fafb | 正确 |
| `--dsw-alias-label-secondary` | 02:335，#61666b/#cfd3d6 | 1413行：#61666b/#cfd3d6 | 正确 |
| `--dsw-alias-label-tertiary` | 02:336，#81858c/#adb2b8 | 1413行：#81858c/#adb2b8 | 正确；3.71不够普通小字 |
| `--dsw-alias-label-caption` | 02:337，#adb2b8/#81858c | 1413行：#adb2b8/#81858c | 正确（补前缀） |
| `--dsw-alias-label-primary-foreground` | 02:338，白/#0f1115 | 1413行：#fff/#0f1115 | 正确（补前缀） |
| `--dsw-alias-brand-primary` | 02:339，中性近黑/近白 | 1413行：#0f1115/#f9fafb | 正确，不是蓝 |
| `--dsw-alias-state-business-primary` | 02:340，#4176e6/#7aaaff | 1413行：#4176e6/#7aaaff | 正确 |
| `--dsw-alias-state-success-primary` | 02:341，两主题#22c55e | 1413行：均引用green-500，#22c55e | 正确 |
| `--dsw-alias-state-warn-primary` | 02:342，两主题#f59e0b | 1413行：均引用amber-500，#f59e0b | 正确 |
| `--dsw-alias-state-error-primary` | 02:343，#ec1313/#f25a5a | 1413行：#ec1313/#f25a5a | 正确 |
| `--dsw-alias-state-idle-primary` | 02:344，#d4d4d4/#545557 | 1413行：#d4d4d4/#545557 | 正确（补前缀） |
| `--dsw-alias-interactive-bg-hover` | 02:345，蓝灰6%/白8% | 1413行：#2631480f/#ffffff14 | 正确（取整） |
| `--dsw-alias-interactive-bg-hover-danger` | 02:346，红5%/红15% | 1413行：#ec13130d/#f25a5a26 | 正确（补前缀） |
| `--dsw-alias-bg-mask-1` | 02:347，黑24%/黑50% | 1413行：#0000003d/#00000080 | 正确（取整） |
| `--dsw-alias-scrollbar-bg-l2` | 02:309/374，存在，没声称hex | 1413行：#e5e5e5/#545557 | 正确 |
| `--dsw-alias-scrollbar-hover-l2` | 同上，hover存在 | 1413行：#d4d4d4/#65676b | 正确（补前缀） |
| `--dsw-alias-tooltip-key-bg` | 02:25/401，宿主混white18% | 1413行：`color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%)` | 正确 |
| `--dsw-focus-ring-width` | 02:370/456，2px | 1416行：2px | 正确 |
| `--dsw-focus-ring-color` | 02:370，默认transparent需局部赋值 | 1416行：transparent | 正确 |
| `--dsw-font-family` | 02:69，系统栈 | 1407行：默认系统栈；有用户设置覆盖分支，含Segoe UI/PingFang SC/Microsoft YaHei等 | 正确（默认值） |
| `--dsw-font-markdown-code-font-family` | 02:69/79，SF Mono/JetBrains Mono/Consolas等 | 1425行：`var(--ds-font-family-code)`；1407行默认代码栈包含所列字体，允许用户覆盖 | 正确（默认值） |
| `--dsw-font-xs-13` | 02:74，13/20、400 | 1425行：`13px/20px var(--dsw-font-family)` | 正确 |
| `--dsw-font-markdown-base` | 02:76，默认14/24并跟随设置 | 1425行：`var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)` | 正确，行高也随delta变 |
| `--dsw-font-base-strong-16` | 02:77，500 16/24 | 1425行：`500 16px/24px var(--dsw-font-family)` | 正确 |
| `--dsw-font-l-20` | 02:78，500 20/28 | 1425行：`500 20px/28px var(--dsw-font-family)` | 正确 |
| `--dsw-radius-xs` | 02:123，4px | 1407行：4px | 正确 |
| `--dsw-radius-sm` | 02:124、总案126，8px | 1407行：8px | 正确 |
| `--dsw-radius-md` | 02:125，12px | 1407行：12px | 正确 |
| **族级反证** `--dsw-radius-xl` | 02:46称只有4/8/12/16/28，漏20 | 1407行：**20px**，另有lg16和panel28 | **存在但族级集合不符，B01** |
| **族级反证** `--dsw-font-xxs-12`、`--dsw-font-xxxs-11` | 02:73称宿主最小13 | 1425行：**12px/18px、11px/14px** | **存在但族级下限不符，B01** |
| **族级反证** `--dsw-font-markdown-h1-font-weight`、`--dsw-font-xl-24` | 02:82称400/500与宿主最大字重一致 | 1425行：**700**；`xl-24:600 24px/32px ...` | **存在但族级上限不符，B01** |

每个具体变量均执行了独立grep，采用如下形态，随后递归解析引用，非只搜前缀：

```bash
grep -noE -- '--dsw-alias-brand-primary:[^;}]*' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
# 1413:--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000)
# 1413:--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50)

grep -noE -- '--dsw-radius-xl:[^;}]*' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
# 1407:--dsw-radius-xl:20px

grep -noE -- '--dsw-font-xxxs-11:[^;}]*' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
# 1425:--dsw-font-xxxs-11:11px/14px var(--dsw-font-family)
```

### 2 一致性问题清单

先承认有效仲裁：总案§6确实选定**208×96基准、运行business、默认1.5px border-l3、状态不换填充层、圆角8、视觉20/逻辑4网格、八态、不灰置无效运行按钮、底部指标抽屉**。旧分册没同步，不等于这些已有裁决全无效。

但总案规定冲突以§6为准，没有授权实现者对其余冲突任选02/03；02又自称全部视觉数值仲裁层。以下仍需处理：

| 编号/严重级别 | 对撞证据 | §6覆盖与结论 |
|---|---|---|
| C01 BLOCKER | [总案:54](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L54>)亮色底混3.5%并为主题特例；[02:355、405](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L355>)纯bg-base，主题分支仅供对比度兜底 | 未覆盖，不能同时实现 |
| C02 BLOCKER | [总案:55](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L55>)选中中性；[02:359、451](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L359>)选中business | 运行色裁决不等于选中色裁决 |
| C03 BLOCKER | [总案:100–102](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L100>)团队116、默认成员行、双击泳道；[02:239–240](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L239>)96默认/144展开；[03:155–168](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L155>)96默认/72+26×n | 基准208×96没裁决团队例外；03例图有主管+4子共5行，n=4公式漏主管行 |
| C04 BLOCKER | [总案:110](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L110>)冻结位置/形状/几何；[03:172、355](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L172>)运行展开重排；[02:193、198](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L193>)说不动结构却切48高紧凑形状 | 未覆盖，应区分内容隐藏、实际矩形变高、结构重排 |
| C05 MAJOR | [01:201](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L201>)整理列距160；[03:53](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L53>)列距260、净隙52 | 未覆盖，160若为原点距卡片重叠48；若为净隙又与52冲突 |
| C06 MAJOR | [01:203](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L203>)主干下80起；[03:43](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L43>)下24起；[总案:89、91](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L89>)相邻段同时写80和24 | 未覆盖，要分清总净空与第一航道偏移 |
| C07 MAJOR | [01:191、226](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L191>)Ctrl绕过、键盘20/100步进；[02:117](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L117>)Alt绕过、逻辑4 | 网格裁决只解决4px，不解决修饰键及键盘步进 |
| C08 MAJOR | [总案:57](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L57>)LOD60/45%；[02:197–199](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L197>)70/50% | 未覆盖，fit67–69%时渲染分歧直接影响标题 |
| C09 MAJOR | [总案:81](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L81>)检查器常驻；[02:310](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L310>)无选中不显示/滑入，误标01来源 | 未覆盖，清选是否改画布宽度影响空间记忆 |
| C10 MAJOR | [03:84–87、192](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L84>)固定±8/24/40/56槽、r10；[02:265、277](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L265>)r8与中心扇出±10/20 | 未覆盖，03的四线交叉证明不能自动套到02不同几何 |
| C11 MAJOR | [03:228、315](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L228>)目标累计返工、线上刻度；[04:276](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L276>)源头标数、不在线上标数字 | 八态裁决没解决计数归属，须分源发起数/目标返工数/边触发数 |
| C12 MAJOR | [04:314](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L314>)双击新建不受运行态影响；[01:170](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L170>)运行锁结构 | 原则应该锁，但具体例外需明确废止并覆盖全部编辑入口 |
| C13 MAJOR | [总案:135](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/DESIGN.md#L135>)40收起条含六项摘要；[04:224–242](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L224>)40只是把手，66/84行摘要另48 | §6仅定位置40/200，没裁决内容 |
| C14 MAJOR | [02:429、436](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L429>)强强调/脉冲≤2；[03:257](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L257>)所有在跑子agent双环脉冲，可达6个 | 缺优先级与降级，多个成员并行即撞预算 |
| C15 MINOR | [01:50、127、165](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L50>)抽屉/菜单/拖动投影；[02:314、434](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L314>)投影0 | 总案§3已选0，但§6未盖掉具体样式，应标旧规格失效 |
| C16 MINOR | [02:48](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L48>)数字胶囊保留20；同册[149、294行](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L149>)又统一18 | 总案遗漏，02自身裁决也没贯彻 |

另有语义细节（MINOR）：总案说“实＝本次发生”，但[03:199–200、314](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L199>)发生后又回落虚线。能这样做，但此时“曾发生/未发生”靠刻度，不是靠实虚，需要准确描述。

### 3 需求覆盖矩阵（任务书 §3 六问 × 判定）

| 六问 | 判定 | 已回答与证据 | 缺口/严重级别 |
|---|---|---|---|
| 1 打回不乱 | **部分回答** | [03:58–143](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L58>)航道、口位、排序、桥拱、标签、轮次与>6降级；四边单行模板可算 | 不能推到所有合法图；五线同目标、同列/手动多行、标签碰撞未定。MAJOR |
| 2 主管+子agent | **部分回答** | [03:145–174、252–266](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L145>)成员点、泳道、主管三阶段、检查器 | 默认是否见成员、高度、展开重排冲突；上限现状8变6无旧数据口径。BLOCKER |
| 3 运行叠加设计 | **部分回答** | [03:274–305](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L274>)通道分配/八态，同一图原则明确 | 展开/LOD与冻结相撞，运行新建例外，过期通过失效/恢复未定。BLOCKER/MAJOR |
| 4 指标看板 | **部分回答** | [04:139–150、244–254、278–299](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L139>)底部抽屉、节点检查器、复盘顺序，不藏二级页 | 位置有答案；完成度、规范、缺陷生命周期、采纳率及未知值未闭合。MAJOR |
| 5 信息密度 | **部分回答** | [02:207–244](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/02-visual-system.md#L207>)三层卡/LOD；[04:168–174](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L168>)两自由数字+skill+token条，确实做取舍 | 02运行替换整徽标行与04常驻skill冲突；团队内容/高度未定；低缩放丢双编码。MAJOR |
| 6 编辑手感 | **部分回答** | [01:176–250](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L176>)操作表、阈值、框选、平移、吸附、整理、撤销、输入隔离充分 | 滚轮改变硬决策、Ctrl/Alt与列距冲突；键盘/点击连线替代缺失；事务需重构。MAJOR |

用户原话专项核对：**任务完成度有落点，但目前是阶段进度；完成得好不好有规则，但存在M02假阳性；有没有符合编码规范有组件位置，却只有名称，没有可检测定义。**这三项不能判“完全没回答”，也不能判完整解决。六问全部部分回答，原因均是具体契约/边界缺口，而非认为设计没有工作量。

### 4 可实现性三档清单

现状证据：

- [现有客户端产物](</home/feiyueve/文档/dsh/dsh-flow-studio/lib/client.js>)stat为**46,512字节**，距262,144余**215,632字节**。未重新构建。[构建脚本:26–46](</home/feiyueve/文档/dsh/dsh-flow-studio/scripts/build.mjs#L26>)已有minify和字节门禁；没有证据说菜单/泳道/抽屉必然装不下。
- [画布:25–31、97–114、347](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L25>)命中、矩形、锚点与DOM依赖固定NODE_W/H；[模型:14–15](</home/feiyueve/文档/dsh/dsh-flow-studio/src/model.js#L14>)是208×88，变体不是只改CSS。
- [画布:4–6、327–328](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L4>)DOM随world缩放而SVG在屏幕坐标；“恒24px热区”要明定屏幕/逻辑px，DOM24在25%仅6px。
- [page:83–100、172–181](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/page.js#L83>)整流替换/校验/保存，[inspector:99–125](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/inspector.js#L99>)每字符提交，需适配失焦一步撤销。

| 档位 | 元素/成本 | 依据及条件 |
|---|---|---|
| **必做** | token、反色前景、文字/图形色分离；低–中 | B01/B02/B04。现状[styles:46](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/styles.js#L46>)brand主按钮还硬写白字，暗色brand近白会翻车，保留02反色token规则。 |
| **必做** | 节点矩形/锚点/命中共用函数；中–高 | 固定宽高依赖广，先裁决团队变体；fit还应包航道/标签，[canvas:237–242](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L237>)目前仅包节点。 |
| **必做** | 简单正交航道、稳定槽位/超额退化；中 | 替换[canvas:43–53](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L43>)大贝塞尔即可，无需第三方图形库。四线单行是首个用例，不是泛化证明。 |
| **必做** | 拖放/字段/多选事务、撤销和输入隔离；高 | 01明确本版范围，先定义提交边界，不能每move入栈/每字符整流历史。 |
| **必做** | 实时连线合法性及键盘/点击替代；中 | [canvas:167–172](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/canvas.js#L167>)松手才判目标；[page:247–255](</home/feiyueve/文档/dsh/dsh-flow-studio/src/client/page.js#L247>)仅基本过滤与可达判型，未连通两点会归打回，需定义建图时规则。 |
| **必做** | 草稿和恢复契约；中 | 若保留本地副本文案，M06存储不能缺；要验切页恢复和覆盖冲突。 |
| **必做** | 运行指标最小定义；设计低、接入高 | 引擎可延后，完成/规范/P0/skill去重/token互斥/缺失值现在应定，否则后续反改组件。 |
| **可延后** | 全几何桥拱、任意手排标签自动避让；高 | 仅有四线用例，曲线/拐角/标签/缩放交点处理复杂；先固定适用范围与降级。 |
| **可延后** | 就地团队多行泳道、“展开所有”；中–高 | 默认成员行+检查器可先看谁在跑；泳道增加动态矩形、航道移动及冻结冲突。 |
| **可延后** | 抽屉连续拖高及200/320吸附；中 | 点击展开/收起已满足位置需求；[04:65、321](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L65>)拖高另需交互/替代/持久化。 |
| **可延后** | 历史P90卡住/token异常；高 | [04:331、339](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L331>)未给样本量、任务/模型分组、冷启动或缺失回退，不能随意把长任务染故障。 |
| **可延后** | 每秒数字位移动画、整理按列stagger；低–中 | [04:330](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L330>)动画不影响信息正确性；先tabular-nums/1Hz，减少强调预算冲突。 |
| **建议砍掉** | 身份六色及双主题维护 | B02硬约束违例，首字/顺序已能识别。 |
| **建议砍掉** | 当前优良可自动评分表，直至证据口径成立 | M02反例明确；先展示事实摘要/行动项，避免无依据绿灯。 |
| **建议砍掉** | 缓存命中“无成本”承诺 | 计费不是构成条能推导的事实，M04；用量展示可保留。 |

React手写、原生SVG和CSS token本身可行。拒绝子画布/力导是合理范围控制，但“262KB必养不起”没有量化证明；应以监督需求及维护成本决定，不捏造字节结论。

### 5 可用性问题

日常盯流水线的开发者会烦的五个具体场景：

1. **想看整条主干，又想看谁卡住，只能反复切全览、放大、双击、检查器（MAJOR）。** 团队默认成员行三套说法，fit67–69%可能落紧凑档，<50%全部名/状态字消失。证据B03/M07/M11。当前运行者和待人工者至少应有可达的名字/动作入口。
2. **看到P0或规范不符合，缺少一键到问题和证据（MAJOR）。** [04:222、246–254、307–314](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L222>)只规定单节点检查器与运行分页，没有整次run的P0点击后选哪个节点、聚合缺陷怎么跨节点、规范证据怎么打开。补摘要异常→问题→证据/节点路径。
3. **滚轮和辅助键改习惯，连线还得拖，精细操作容易反复试错（MAJOR）。** M08/M09有现状与设计行号；这是肌肉记忆迁移，不能当皮肤变化，需要唯一裁决和可发现入口。
4. **第七条打回靠hover才出现，容易漏读，“全部”也不知是否真的全部（MAJOR）。** [03:140–143](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/03-semantics.md#L140>)同时要求最多六航道、第七不画、工具栏全部开关，未说明优先级/focus替代/隐藏边运行触发时如何出现。至少常驻还有N条入口与相关边筛选。
5. **看到绿勾、完成度和“良”，仍不知道是否可交付（MAJOR）。** M01–M03：旧中间阶段保留passed、规范未检测无状态、测试50%也可能良。用户仍得手工翻测试/审查日志。应直给未解决及未检测项。

补充MINOR：抽屉每次运行自动展开200px会抢画布。[01:40](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/01-ia-interaction.md#L40>)最小600高净524，扣200仅324；不是[04:49](</home/feiyueve/文档/dsh/dsh-flow-studio/docs/design/04-metrics.md#L49>)假设约700。建议记住用户收起选择，异常提示即可。

### 6 三项视觉风险独立验证

#### 同白画布与卡片：事实正确，处理未闭合（BLOCKER关联B03）

源码确认bg-base与layer-1/2/3亮色都是白。02选择同白+描边，总案选择亮色底混label-primary 3.5%，必须先唯一化。

border-l3真实alpha31/255，白底合成约#e0e0e0，对白**1.3201:1**；hover border-l4合成约#d6d6d6，对白**1.4534:1**。能产生边界，但不能用图形≥3证明。是否必须3取决于边界是否承担识别交互对象的必要信息；本报告不把装饰细边一概判WCAG失败，但“边界立住”应看白底真实尺寸截图，不能用宿主风格代替验证。画布混3.5%也不解决白卡上文字对比度。

#### brand-primary中性：事实纠正有效，用途仍冲突（BLOCKER关联B03）

brand亮#0f1115/暗#f9fafb；business亮#4176e6/暗#7aaaff。总案§6运行改business有效，03原来brand蓝光晕视为已覆盖。未解的是总案选中中性与02选中蓝，以及焦点、选中和运行共用蓝时的强调优先级；必须保留状态形状/文字，避免选中被误读为执行。

#### 成功/警告对白：只解决线条，未解决小字（BLOCKER关联B04）

70/30混合先在sRGB通道算，再转线性相对亮度；不先舍入8位hex。结果：

| 颜色 | 白底对比度 | 暗色画布#151517对比度 | 判定 |
|---|---|---|---|
| success原色 | 2.2786 | 8.0034 | 亮色细图形也不足3 |
| warn原色 | 2.1477 | 8.4914 | 同上 |
| R1-success | **4.1395** | **9.9154** | 亮色图形通过；普通小字4.5失败 |
| R1-warn | **3.9350** | **10.4562** | 同上 |
| business原色 | **4.2349** | 7.8343 | 图形通过；白底普通小字失败 |
| label-tertiary | **3.7056** | 8.5427 | 图形可用；白底12/13px信息字不够4.5 |

文档3.92/10.48、4.14/9.93与浮点复算有小差异，舍入误差不是阻断点；把它们勾成小字合法才是错误。SVG对勾等适用图形3，不应把4.14的SVG图标也误判为文字失败。暗色表在画布底计算，卡片/混色chip应另验实际背景。

可复算代码（只读常数与stdout，不产生额外文件）：

```python
def rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]

def luminance(c):
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return sum(v * w for v, w in zip(linear, (0.2126, 0.7152, 0.0722)))

def contrast(a, b):
    low, high = sorted((luminance(a), luminance(b)))
    return (high + 0.05) / (low + 0.05)

for name, color in [('success', '#22c55e'), ('warn', '#f59e0b')]:
    for theme, partner, background in [('亮', '#0f1115', '#ffffff'), ('暗', '#f9fafb', '#151517')]:
        mixed = [a * 0.7 + b * 0.3 for a, b in zip(rgb(color), rgb(partner))]
        print(name, theme, f'{contrast(mixed, rgb(background)):.4f}')
# success 亮 4.1395
# success 暗 9.9154
# warn 亮 3.9350
# warn 暗 10.4562
```

## 我会怎么改（按性价比排序）

1. **先纠正事实与硬约束，去掉虚假达标勾。** 修token族断言、取消身份色豁免，分开图形与小字配方，消除B01/B02/B04。
2. **一页补齐唯一仲裁。** 先定团队默认/展开矩形、重排与锚点、亮色底、选中色、LOD、输入协议，标注旧段落废止，避免继续精修一套会重做的几何。
3. **把三个用户问题转成可核验事实。** 分阶段进度与验收完成度；质量看当前未解决缺陷/测试证据/规范状态，未知明确显示；用M02反例修评分后再决定保留优良可。
4. **预算先投编辑事务和草稿恢复。** 拖放/失焦可撤销、断网切页恢复、点按/键盘连线优先；任意桥拱、全团队泳道、连续拖高、数字动画延后。
5. **用三个反例图验收。** 出厂四打回、五条同入一个节点、多行/长链30节点；亮暗、60%与全览档检查标签可达、灰度状态可辨、fit真包含航道。需要反例验证，不需再加视觉概念。
