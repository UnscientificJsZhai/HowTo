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
        required: ["title", "command", "description", "placeholders"],
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
