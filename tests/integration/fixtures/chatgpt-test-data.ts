export const CHATGPT_TEST_MODEL = "chatgpt-test";
export const CHATGPT_TEST_TOKEN = "HOWTO_FAKE_CHATGPT_TOKEN";
export const CHATGPT_TEST_SECRET = "HOWTO_FAKE_CHATGPT_UPSTREAM_SECRET";
export const CHATGPT_TEST_CATALOG = {
  models: [{ slug: CHATGPT_TEST_MODEL, display_name: "Test model", visibility: "list" }],
};
export const CHATGPT_TEST_TEXT = JSON.stringify({
  commands: [
    {
      title: "List files",
      command: "ls",
      description: "List files",
      dangerous: false,
      dangerReason: "",
      placeholders: [],
    },
  ],
});

export function chatGptTestFrame(value: unknown, name?: string): string {
  return `${name === undefined ? "" : `event: ${name}\n`}data: ${JSON.stringify(value)}\n\n`;
}

export function chatGptTestCompleted(text = CHATGPT_TEST_TEXT): string {
  return chatGptTestFrame(
    {
      type: "response.completed",
      response: {
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          },
        ],
      },
    },
    "response.completed",
  );
}

export function chatGptSubscriptionTestCompleted(): string {
  return (
    chatGptTestFrame({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: CHATGPT_TEST_TEXT }],
      },
    }) +
    chatGptTestFrame({
      type: "response.completed",
      response: { status: "completed", output: [] },
    })
  );
}
