const CONFIG = {
    API: {
        BASE_URL: "wss://api.inkeep.com/graphql",
        API_KEY:"sk-123456",//自行修改或者默认,
        SYSTEM_MESSAGE: null //自行选择是否添加，string字符串类型
    },
    CORS: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
    },
    MODEL: "claude-3-5-sonnet-20241022",
};

function processMessageContent(content: any): string | null {
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
        return content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
    }
    
    return content?.text || null;
}

async function formatMessages({ messages }: { messages: any[] }) {
    const systemMessageList: string[] = [];
    let systemMergeMode = false;

    const contextMessages = await messages.reduce(async (accPromise, current) => {
        const acc = await accPromise;
        const currentContent = processMessageContent(current.content);
        if (!currentContent) return acc;

        const currentRoleTag = ["system", "user"].includes(current.role)
            ? "Human"
            : "Assistant";
        if (current.role === "system" && !systemMergeMode) {
            systemMessageList.push(currentContent);
            systemMergeMode = true;
        } else if (current.role !== "system" && systemMergeMode) {
            systemMergeMode = false;
        }

        const previousMessage = acc[acc.length - 1];
        const newMessage = `${currentRoleTag}: ${currentContent}`;
        if (!previousMessage || previousMessage.startsWith(currentRoleTag)) {
            return previousMessage
                ? [...acc.slice(0, -1), `${previousMessage}\n${currentContent}`]
                : [...acc, newMessage];
        }
        return [...acc, newMessage];
    }, Promise.resolve([]));

    return {
        contextMessages: "XmlPlot: \r\n"+contextMessages.join('\n'),
        systemMessage: systemMessageList.join("\n"),
    };
}

function sendSubscription(ws: WebSocket, requestPayload: any) {
    ws.send(
        JSON.stringify({
            id: crypto.randomUUID(),
            type: "subscribe",
            payload: {
                variables: {
                    messageInput: requestPayload.contextMessages,
                    messageContext: null,
                    organizationId: "org_JfjtEvzbwOikUEUn",
                    integrationId: "clwtqz9sq001izszu8ms5g4om",
                    chatMode: "AUTO",
                    context: requestPayload.systemMessage || CONFIG.API.SYSTEM_MESSAGE,
                    messageAttributes: {},
                    includeAIAnnotations: false,
                    environment: "production",
                },
                extensions: {},
                operationName: "OnNewSessionChatResult",
                query: `subscription OnNewSessionChatResult($messageInput: String!, $messageContext: String, $organizationId: ID!, $integrationId: ID, $chatMode: ChatMode, $filters: ChatFiltersInput, $messageAttributes: JSON, $tags: [String!], $workflowId: String, $context: String, $guidance: String, $includeAIAnnotations: Boolean!, $environment: String) {
            newSessionChatResult(input: {messageInput: $messageInput, messageContext: $messageContext, organizationId: $organizationId, integrationId: $integrationId, chatMode: $chatMode, filters: $filters, messageAttributes: $messageAttributes, tags: $tags, workflowId: $workflowId, context: $context, guidance: $guidance, environment: $environment}) {
              isEnd
              sessionId
              message { id content }
              __typename
            }
          }`,
            },
        })
    );
}

function setupWebSocket(
    requestPayload: any, 
    onMessage: (message: any, ws: WebSocket, timeoutId: number) => void, 
    onError: (err: Error) => void
): WebSocket {
    const ws = new WebSocket(CONFIG.API.BASE_URL, "graphql-transport-ws");
    const timeoutId = setTimeout(() => {
        ws.close();
        onError(new Error("WebSocket connection timeout."));
    }, 60000);

    ws.onopen = () => {
        ws.send(
            JSON.stringify({
                type: "connection_init",
                payload: { headers: { Authorization: `Bearer ee5b7c15ed3553cd6abc407340aad09ac7cb3b9f76d8613a` } },
            })
        );
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === "connection_ack") {
                sendSubscription(ws, requestPayload);
            }
            onMessage(message, ws, timeoutId);
        } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
            ws.close();
            clearTimeout(timeoutId);
        }
    };

    ws.onerror = (err) => {
        onError(err instanceof Error ? err : new Error(String(err)));
        ws.close();
        clearTimeout(timeoutId);
    };

    ws.onclose = () => clearTimeout(timeoutId);
    return ws;
}

function createWebSocketWithStream(requestPayload: any): ReadableStream {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            let lastContent = "";
            const uniqueId = crypto.randomUUID();
            const created = Math.floor(Date.now() / 1000);

            const onMessage = (message: any, ws: WebSocket, timeoutId: number) => {
                if (message.type === "next") {
                    const chatResult = message.payload?.data?.newSessionChatResult;
                    if (chatResult) {
                        const content = chatResult.message.content || "";
                        const delta = content.slice(lastContent.length);
                        if (delta) {
                            const chunk = {
                                id: uniqueId,
                                object: "chat.completion.chunk",
                                created,
                                model: CONFIG.MODEL,
                                choices: [
                                    { index: 0, delta: { content: delta }, finish_reason: null },
                                ],
                            };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            lastContent = content;
                        }
                        if (chatResult.isEnd) {
                            const finalChunk = {
                                id: uniqueId,
                                object: "chat.completion.chunk",
                                created,
                                model: CONFIG.MODEL,
                                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                            };
                            controller.enqueue(
                                encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
                            );
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            controller.close();
                            ws.close();
                            clearTimeout(timeoutId);
                        }
                    }
                } else if (message.type === "error") {
                    controller.error(
                        new Error(`WebSocket error: ${message.payload[0].message}`)
                    );
                    ws.close();
                    clearTimeout(timeoutId);
                }
            };

            const onError = (err: Error) => {
                controller.error(err);
            };

            setupWebSocket(requestPayload, onMessage, onError);
        },
    });
}

function createWebSocketWithoutStream(requestPayload: any): Promise<string> {
    return new Promise((resolve, reject) => {
        let responseContent = "";

        const onMessage = (message: any, ws: WebSocket, timeoutId: number) => {
            if (message.type === "next") {
                const chatResult = message.payload?.data?.newSessionChatResult;
                if (chatResult) {
                    responseContent = chatResult.message.content;
                    if (chatResult.isEnd) {
                        resolve(responseContent);
                        ws.close();
                        clearTimeout(timeoutId);
                    }
                }
            } else if (message.type === "error") {
                reject(new Error(`WebSocket error: ${message.payload[0].message}`));
                ws.close();
                clearTimeout(timeoutId);
            }
        };

        const onError = (err: Error) => reject(err);

        setupWebSocket(requestPayload, onMessage, onError);
    });
}

function handleUnstreamResponse(userMessage: string, responseContent: string, model: string): Response {
    return new Response(
        JSON.stringify({
            id: crypto.randomUUID(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: responseContent },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: userMessage.length,
                completion_tokens: responseContent.length,
                total_tokens: userMessage.length + responseContent.length,
            },
        }),
        {
            headers: {
                "Content-Type": "application/json",
                ...CONFIG.CORS,
            },
        }
    );
}

export async function handler(req: Request) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: { ...CONFIG.CORS },
        });
    }

    try {
        if (url.pathname === "/v1/models" && req.method === "GET") {
            return new Response(
                JSON.stringify({
                    object: "list",
                    data: [
                        {
                            id: CONFIG.MODEL,
                            object: "model",
                            created: Math.floor(Date.now() / 1000),
                            owned_by: "AskAI2API",
                        },
                    ],
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...CONFIG.CORS,
                    },
                }
            );
        }

        if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
            const { messages, model, stream } = await req.json();
            const authToken = req.headers.get("Authorization")?.replace("Bearer ", "");
            if (authToken !== CONFIG.API.API_KEY) {
                return new Response(
                    JSON.stringify({ error: "Unauthorized" }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json", ...CONFIG.CORS },
                    }
                );
            }
            const formattedMessages = await formatMessages({ messages });
            const userMessage =
                messages.reverse().find((msg: any) => msg.role === "user")?.content;
            if (!userMessage)
                return new Response(
                    JSON.stringify({ error: "Please input a valid message." }),
                    {
                        status: 400,
                        headers: { "Content-Type": "application/json", ...CONFIG.CORS },
                    }
                );

            if (stream) {
                const wsStream = createWebSocketWithStream(formattedMessages);
                return new Response(wsStream, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        Connection: "keep-alive",
                        ...CONFIG.CORS,
                    },
                });
            } else {
                const responseContent = await createWebSocketWithoutStream(formattedMessages);
                return handleUnstreamResponse(userMessage, responseContent, model);
            }
        }

        return new Response(
            JSON.stringify({ message: "服务创建成功运行中，请根据规则使用正确请求路径" }),
            {
                status: 500,
                headers: { "Content-Type": "application/json", ...CONFIG.CORS },
            }
        );
    } catch (error) {
        return new Response(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            {
                status: 500,
                headers: { "Content-Type": "application/json", ...CONFIG.CORS },
            }
        );
    }
}

export default {
    async fetch(req: Request) {
        return await handler(req);
    }
};