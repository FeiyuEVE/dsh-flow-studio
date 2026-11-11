/**
 * vendored: zeebe-bpmn-moddle —— 这是第三方代码，**不要手改**。
 *
 * 版本：zeebe-bpmn-moddle@2.0.0
 * 许可：MIT（完整文本见仓库根 THIRD-PARTY.md，随包分发）
 * 来源：npm pack zeebe-bpmn-moddle@2.0.0（https://github.com/camunda/zeebe-bpmn-moddle）
 * tarball shasum：98a831b274cda54c3d1769c661e4e70a1711f4ca
 * tarball integrity：sha512-n1wtWbvpWRA4ROgbjNpFt6SxvSGp+lJHuY+N6hXp7IrxV/VJnfnwrm+UMGY80IgZMdJVz9zgKyPC4QujijBH8w==
 * 打包：esbuild@0.28.2 --bundle --format=esm --platform=neutral（未压缩）
 * 依赖闭包（版本已锁定；各包许可与版权见 THIRD-PARTY.md）：
 *
 * 重新生成：node scripts/vendor-bpmn.mjs（升级改脚本顶部的 VENDORED / CLOSURE 常量）
 * 校验产物：node scripts/vendor-bpmn.mjs --check
 *
 * 本仓库对它只做 bundle，未修改其逻辑；如需打补丁，请在此头部写明 patch 内容，
 * 并同步更新 scripts/vendor-bpmn.mjs，保证「重新生成」仍能复现。
 */

// The MIT License (MIT)
//
// Copyright (c) 2020-present Camunda Services GmbH
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// node_modules/zeebe-bpmn-moddle/resources/zeebe.json
var zeebe_default = {
  name: "zeebe",
  prefix: "zeebe",
  uri: "http://camunda.org/schema/zeebe/1.0",
  xml: {
    tagAlias: "lowerCase"
  },
  associations: [],
  types: [
    {
      name: "ZeebeServiceTask",
      extends: [
        "bpmn:ServiceTask",
        "bpmn:BusinessRuleTask",
        "bpmn:ScriptTask",
        "bpmn:SendTask",
        "bpmn:EndEvent",
        "bpmn:IntermediateThrowEvent",
        "bpmn:AdHocSubProcess"
      ],
      properties: [
        {
          name: "retryCounter",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "IoMapping",
      superClass: [
        "Element"
      ],
      properties: [
        {
          name: "ioMapping",
          type: "IoMapping"
        },
        {
          name: "inputParameters",
          isMany: true,
          type: "Input"
        },
        {
          name: "outputParameters",
          isMany: true,
          type: "Output"
        }
      ],
      meta: {
        allowedIn: [
          "bpmn:CallActivity",
          "bpmn:Event",
          "bpmn:ReceiveTask",
          "zeebe:ZeebeServiceTask",
          "bpmn:SubProcess",
          "bpmn:UserTask"
        ]
      }
    },
    {
      name: "InputOutputParameter",
      properties: [
        {
          name: "source",
          isAttr: true,
          type: "String"
        },
        {
          name: "target",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "Subscription",
      superClass: [
        "Element"
      ],
      properties: [
        {
          name: "correlationKey",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "Input",
      superClass: [
        "InputOutputParameter"
      ],
      meta: {
        allowedIn: [
          "bpmn:CallActivity",
          "zeebe:ZeebeServiceTask",
          "bpmn:SubProcess",
          "bpmn:UserTask"
        ]
      }
    },
    {
      name: "Output",
      superClass: [
        "InputOutputParameter"
      ],
      meta: {
        allowedIn: [
          "bpmn:CallActivity",
          "bpmn:Event",
          "bpmn:ReceiveTask",
          "zeebe:ZeebeServiceTask",
          "bpmn:SubProcess",
          "bpmn:UserTask"
        ]
      }
    },
    {
      name: "TaskHeaders",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask",
          "zeebe:ExecutionListener",
          "zeebe:ZeebeServiceTask"
        ]
      },
      properties: [
        {
          name: "values",
          type: "Header",
          isMany: true
        }
      ]
    },
    {
      name: "Header",
      superClass: [
        "Element"
      ],
      properties: [
        {
          name: "id",
          type: "String",
          isAttr: true
        },
        {
          name: "key",
          type: "String",
          isAttr: true
        },
        {
          name: "value",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "TaskDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "zeebe:ZeebeServiceTask"
        ]
      },
      properties: [
        {
          name: "type",
          type: "String",
          isAttr: true
        },
        {
          name: "retries",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "LoopCharacteristics",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:MultiInstanceLoopCharacteristics"
        ]
      },
      properties: [
        {
          name: "inputCollection",
          type: "String",
          isAttr: true
        },
        {
          name: "inputElement",
          type: "String",
          isAttr: true
        },
        {
          name: "outputCollection",
          type: "String",
          isAttr: true
        },
        {
          name: "outputElement",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "CalledElement",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:CallActivity"
        ]
      },
      properties: [
        {
          name: "processId",
          type: "String",
          isAttr: true
        },
        {
          name: "processIdExpression",
          type: "String",
          isAttr: true
        },
        {
          name: "propagateAllChildVariables",
          isAttr: true,
          type: "Boolean"
        },
        {
          name: "propagateAllParentVariables",
          isAttr: true,
          type: "Boolean",
          default: true
        },
        {
          name: "businessId",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "UserTaskForm",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:Process"
        ]
      },
      properties: [
        {
          name: "id",
          type: "String",
          isAttr: true
        },
        {
          name: "body",
          type: "String",
          isBody: true
        }
      ]
    },
    {
      name: "FormDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask",
          "bpmn:StartEvent"
        ]
      },
      properties: [
        {
          name: "formKey",
          type: "String",
          isAttr: true
        },
        {
          name: "formId",
          type: "String",
          isAttr: true
        },
        {
          name: "externalReference",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "LinkedResource",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:ServiceTask"
        ]
      },
      properties: [
        {
          name: "resourceId",
          type: "String",
          isAttr: true
        },
        {
          name: "resourceType",
          type: "String",
          isAttr: true
        },
        {
          name: "linkName",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "LinkedResources",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:ServiceTask"
        ]
      },
      properties: [
        {
          name: "values",
          type: "LinkedResource",
          isMany: true
        }
      ]
    },
    {
      name: "UserTask",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask"
        ]
      },
      properties: []
    },
    {
      name: "CalledDecision",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:BusinessRuleTask"
        ]
      },
      properties: [
        {
          name: "decisionId",
          type: "String",
          isAttr: true
        },
        {
          name: "resultVariable",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "AssignmentDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask"
        ]
      },
      properties: [
        {
          name: "assignee",
          type: "String",
          isAttr: true
        },
        {
          name: "candidateGroups",
          type: "String",
          isAttr: true
        },
        {
          name: "candidateUsers",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "PriorityDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask"
        ]
      },
      properties: [
        {
          name: "priority",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "JobPriorityDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:Process",
          "zeebe:ZeebeServiceTask"
        ]
      },
      properties: [
        {
          name: "priority",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "TaskSchedule",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask"
        ]
      },
      properties: [
        {
          name: "dueDate",
          type: "String",
          isAttr: true
        },
        {
          name: "followUpDate",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "Properties",
      superClass: [
        "Element"
      ],
      properties: [
        {
          name: "properties",
          type: "Property",
          isMany: true
        }
      ]
    },
    {
      name: "Property",
      properties: [
        {
          name: "name",
          type: "String",
          isAttr: true
        },
        {
          name: "value",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "TemplateSupported",
      isAbstract: true,
      extends: [
        "bpmn:Collaboration",
        "bpmn:Process",
        "bpmn:FlowElement"
      ],
      properties: [
        {
          name: "modelerTemplate",
          isAttr: true,
          type: "String"
        },
        {
          name: "modelerTemplateVersion",
          isAttr: true,
          type: "Integer"
        },
        {
          name: "modelerTemplateIcon",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "ConfigurationSupported",
      isAbstract: true,
      extends: [
        "zeebe:Input",
        "zeebe:Property"
      ],
      properties: [
        {
          name: "modelerConfigurationTemplate",
          isAttr: true,
          type: "String"
        },
        {
          name: "modelerConfigurationName",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "TemplatedRootElement",
      isAbstract: true,
      extends: [
        "bpmn:Error",
        "bpmn:Escalation",
        "bpmn:Message",
        "bpmn:Signal"
      ],
      properties: [
        {
          name: "modelerTemplate",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "Script",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:ScriptTask"
        ]
      },
      properties: [
        {
          name: "expression",
          type: "String",
          isAttr: true
        },
        {
          name: "resultVariable",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "ExecutionListeners",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:Event",
          "bpmn:Activity",
          "bpmn:Process",
          "bpmn:ExclusiveGateway",
          "bpmn:InclusiveGateway",
          "bpmn:ParallelGateway",
          "bpmn:EventBasedGateway"
        ]
      },
      properties: [
        {
          name: "listeners",
          type: "ExecutionListener",
          isMany: true
        }
      ]
    },
    {
      name: "ExecutionListener",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "zeebe:ExecutionListeners"
        ]
      },
      properties: [
        {
          name: "eventType",
          type: "String",
          isAttr: true
        },
        {
          name: "retries",
          type: "String",
          isAttr: true
        },
        {
          name: "type",
          type: "String",
          isAttr: true
        },
        {
          name: "headers",
          type: "TaskHeaders"
        }
      ]
    },
    {
      name: "TaskListeners",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:UserTask"
        ]
      },
      properties: [
        {
          name: "listeners",
          type: "TaskListener",
          isMany: true
        }
      ]
    },
    {
      name: "TaskListener",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "zeebe:TaskListeners"
        ]
      },
      properties: [
        {
          name: "eventType",
          type: "String",
          isAttr: true
        },
        {
          name: "retries",
          type: "String",
          isAttr: true
        },
        {
          name: "type",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "VersionTag",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:Process"
        ]
      },
      properties: [
        {
          name: "value",
          type: "String",
          isAttr: true
        }
      ]
    },
    {
      name: "BindingTypeSupported",
      isAbstract: true,
      extends: [
        "zeebe:CalledDecision",
        "zeebe:CalledElement",
        "zeebe:FormDefinition",
        "zeebe:LinkedResource"
      ],
      properties: [
        {
          name: "bindingType",
          isAttr: true,
          type: "String",
          default: "latest"
        },
        {
          name: "versionTag",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "AdHoc",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:AdHocSubProcess"
        ]
      },
      properties: [
        {
          name: "activeElementsCollection",
          isAttr: true,
          type: "String"
        },
        {
          name: "outputCollection",
          isAttr: true,
          type: "String"
        },
        {
          name: "outputElement",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "ConditionalFilter",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:ConditionalEventDefinition"
        ]
      },
      properties: [
        {
          name: "variableNames",
          isAttr: true,
          type: "String"
        },
        {
          name: "variableEvents",
          isAttr: true,
          type: "String"
        }
      ]
    },
    {
      name: "AgentDefinition",
      superClass: [
        "Element"
      ],
      meta: {
        allowedIn: [
          "bpmn:ServiceTask",
          "bpmn:AdHocSubProcess"
        ]
      },
      properties: [
        {
          name: "agentType",
          type: "String",
          isAttr: true
        }
      ]
    }
  ]
};

// entry-zeebe-bpmn-moddle.mjs
var entry_zeebe_bpmn_moddle_default = zeebe_default;
export {
  entry_zeebe_bpmn_moddle_default as default,
  zeebe_default as zeebeModdle
};
