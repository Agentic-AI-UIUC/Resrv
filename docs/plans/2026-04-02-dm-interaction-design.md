# DM-Based Bot Interaction with Natural Language

**Date:** 2026-04-02
**Status:** Approved

## Summary

Users can DM the bot to manage their queue status using natural language. An OpenAI classifier extracts intent and optional machine name, then executes the appropriate action.

## Supported Intents

| Intent | Example messages | Action |
|--------|-----------------|--------|
| `done` | "I'm done", "finished my print" | Mark entry as completed (or leave if still waiting) |
| `more_time` | "I need more time", "not done yet" | Reset reminded flag to restart 30-min timer |
| `check_position` | "where am I", "check my spot" | Reply with current position/status |
| `leave` | "remove me", "I want to leave" | Cancel their queue entry |
| `unknown` | anything else | Reply with help message listing available actions |

## Architecture

```
User DMs bot
    -> on_message (dm cog, ignores bots and guild messages)
    -> OpenAI gpt-4o-mini classifies intent + extracts machine name
    -> Lookup user's active queue entries
    -> If ambiguous (multiple entries, no machine specified):
        -> Reply with button menu: "Which machine?"
        -> Wait for button click
    -> Execute action against database
    -> DM confirmation to user
    -> notify_embed_update(machine_id) to refresh Discord embed
```

## OpenAI Classifier

- Model: `gpt-4o-mini` (cheap, fast, sufficient for classification)
- Stateless: no conversation history, each DM is independent
- Output format: `{"intent": "...", "machine": "..." | null}`
- Machine names matched fuzzily by the AI (e.g., "laser" -> "laser-cutter")
- Fallback on API failure: show button menu with 4 action buttons

## Edge Cases

- **Not in any queue** -> helpful message pointing to queue channel
- **"done" while waiting (not serving)** -> treat as "leave", confirm removal
- **"more time" while waiting** -> inform them they're not being served yet
- **OpenAI failure** -> fall back to button menu
- **Rate limiting** -> 5-second cooldown per user to prevent spam

## Files Changed

| File | Change |
|------|--------|
| `config.py` | Add `openai_api_key` setting |
| `requirements.txt` | Add `openai` |
| `bot/cogs/dm.py` | New cog: on_message listener, OpenAI classifier, intent handlers, ambiguity buttons |
| `db/models.py` | Add `reset_reminder(entry_id)` helper |
| `bot/bot.py` | Load dm cog in setup_hook, enable message_content intent for DMs |

## No Schema Changes

The `reminded` flag reset and existing `update_entry_status` / `leave_queue` functions cover all needed DB operations.
