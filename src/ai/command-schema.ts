export const COMMAND_GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["commands"],
  properties: {
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "command", "description", "dangerous", "dangerReason", "placeholders"],
        properties: {
          title: {
            type: "string",
          },
          command: {
            type: "string",
          },
          description: {
            type: "string",
          },
          dangerous: {
            type: "boolean",
          },
          dangerReason: {
            type: "string",
          },
          placeholders: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "description"],
              properties: {
                name: {
                  type: "string",
                },
                description: {
                  type: "string",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const USAGE_COMMAND_GENERATION_SCHEMA = {
  ...COMMAND_GENERATION_SCHEMA,
  required: ["commands", "failureReason"],
  properties: {
    commands: { ...COMMAND_GENERATION_SCHEMA.properties.commands, minItems: 0 },
    failureReason: { type: "string" },
  },
} as const;
