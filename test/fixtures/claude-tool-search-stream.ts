/** A real Messages stream from a turn in which the server ran the tool search tool (ids replaced). Request: one deferred tool plus `tool_search_tool_regex_20251119`. */
export const claudeToolSearchStream: readonly Record<string, unknown>[] = [
  {
    "type": "message_start",
    "message": {
      "model": "claude-sonnet-5-5",
      "id": "msg_fixture",
      "type": "message",
      "role": "assistant",
      "content": [],
      "container": null,
      "stop_reason": null,
      "stop_sequence": null,
      "stop_details": null,
      "usage": {
        "input_tokens": 728,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 0
        },
        "output_tokens": 24,
        "service_tier": "standard",
        "inference_geo": "global",
        "speed": "standard"
      },
      "diagnostics": null,
      "context_management": null
    }
  },
  {
    "type": "content_block_start",
    "index": 0,
    "content_block": {
      "type": "server_tool_use",
      "id": "srvtoolu_fixture",
      "name": "tool_search_tool_regex",
      "input": {}
    }
  },
  {
    "type": "ping"
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": ""
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\"patte"
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "rn\": \"t"
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "ime|hor"
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "a|timez"
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "one|clo"
    }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "ck\"}"
    }
  },
  {
    "type": "content_block_stop",
    "index": 0
  },
  {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_search_tool_result",
      "tool_use_id": "srvtoolu_fixture",
      "content": {
        "type": "tool_search_tool_search_result",
        "tool_references": [
          {
            "type": "tool_reference",
            "tool_name": "hora_atual"
          }
        ]
      }
    }
  },
  {
    "type": "content_block_stop",
    "index": 1
  },
  {
    "type": "content_block_start",
    "index": 2,
    "content_block": {
      "type": "tool_use",
      "id": "toolu_fixture",
      "name": "hora_atual",
      "input": {},
      "caller": {
        "type": "direct"
      }
    }
  },
  {
    "type": "content_block_delta",
    "index": 2,
    "delta": {
      "type": "input_json_delta",
      "partial_json": ""
    }
  },
  {
    "type": "content_block_delta",
    "index": 2,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\"fuso\""
    }
  },
  {
    "type": "content_block_delta",
    "index": 2,
    "delta": {
      "type": "input_json_delta",
      "partial_json": ": \"Euro"
    }
  },
  {
    "type": "content_block_delta",
    "index": 2,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "pe/Berl"
    }
  },
  {
    "type": "content_block_delta",
    "index": 2,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "in\"}"
    }
  },
  {
    "type": "content_block_stop",
    "index": 2
  },
  {
    "type": "message_delta",
    "delta": {
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "stop_details": null,
      "container": null
    },
    "usage": {
      "input_tokens": 1638,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "output_tokens": 124,
      "output_tokens_details": {
        "thinking_tokens": 0
      },
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "iterations": [
        {
          "input_tokens": 728,
          "output_tokens": 66,
          "cache_read_input_tokens": 0,
          "cache_creation_input_tokens": 0,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 0
          },
          "type": "message"
        },
        {
          "input_tokens": 910,
          "output_tokens": 58,
          "cache_read_input_tokens": 0,
          "cache_creation_input_tokens": 0,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 0
          },
          "type": "message"
        }
      ]
    },
    "context_management": {
      "applied_edits": []
    }
  },
  {
    "type": "message_stop"
  }
]
