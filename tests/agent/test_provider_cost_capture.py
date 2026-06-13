"""Real provider-reported cost capture — never estimated, absent ≠ zero.

Covers the three fixture shapes from the cost-tracking fix:
  - OpenRouter usage accounting: response ``usage.cost`` present → accumulates.
  - Nous: ``x-nous-credits-*`` headers present → header delta accumulates.
  - Provider reports nothing → cost stays None/absent (NOT zero-as-real).
"""

from types import SimpleNamespace

import pytest

from agent.usage_pricing import extract_provider_cost_usd, nous_header_cost_usd, real_session_cost_usd


# ── extract_provider_cost_usd — the per-response REAL cost reader ────────────


class TestExtractProviderCost:
    def test_openrouter_usage_cost_attr(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, cost=0.001234)
        assert extract_provider_cost_usd(usage) == pytest.approx(0.001234)

    def test_dict_shaped_usage(self):
        assert extract_provider_cost_usd({"cost": 0.5}) == pytest.approx(0.5)

    def test_reported_zero_is_real_zero(self):
        # Free-tier models really cost $0 — distinct from "not reported".
        usage = SimpleNamespace(cost=0)
        assert extract_provider_cost_usd(usage) == 0.0

    def test_absent_cost_is_none_not_zero(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5)
        assert extract_provider_cost_usd(usage) is None
        assert extract_provider_cost_usd({"prompt_tokens": 10}) is None

    def test_none_usage_is_none(self):
        assert extract_provider_cost_usd(None) is None

    def test_garbage_cost_values_are_none(self):
        for bad in ("0.01", True, float("nan"), float("inf"), -0.5, [], {}):
            assert extract_provider_cost_usd(SimpleNamespace(cost=bad)) is None, bad


# ── real_session_cost_usd — the session accumulator surface ─────────────────


class _FakeAgent:
    def __init__(self, actual=None, credits_micros=None):
        self.session_actual_cost_usd = actual
        self._credits_micros = credits_micros

    def get_credits_spent_micros(self):
        return self._credits_micros


class TestRealSessionCost:
    def test_nothing_reported_is_none(self):
        assert real_session_cost_usd(_FakeAgent()) is None

    def test_openrouter_accumulator_only(self):
        assert real_session_cost_usd(_FakeAgent(actual=0.42)) == pytest.approx(0.42)

    def test_nous_credits_delta_only(self):
        # 123_400 micros = $0.1234
        assert real_session_cost_usd(
            _FakeAgent(credits_micros=123_400)
        ) == pytest.approx(0.1234)

    def test_both_sources_sum(self):
        assert real_session_cost_usd(
            _FakeAgent(actual=0.10, credits_micros=200_000)
        ) == pytest.approx(0.30)

    def test_negative_credits_delta_clamped(self):
        # A mid-session top-up makes the delta negative — never show negative cost.
        assert real_session_cost_usd(_FakeAgent(credits_micros=-50_000)) == 0.0

    def test_agent_without_credits_method(self):
        agent = SimpleNamespace(session_actual_cost_usd=None)
        assert real_session_cost_usd(agent) is None

    def test_non_numeric_actual_ignored(self):
        agent = _FakeAgent()
        agent.session_actual_cost_usd = "0.42"  # corrupted attr → ignore
        assert real_session_cost_usd(agent) is None


# ── nous_header_cost_usd — the CHROME status-bar cost (F3: header-only) ──────


class TestNousHeaderCost:
    def test_header_delta_only(self):
        # 123_400 micros = $0.1234 — the Nous header source feeds the chrome.
        assert nous_header_cost_usd(_FakeAgent(credits_micros=123_400)) == pytest.approx(0.1234)

    def test_openrouter_accumulator_ignored(self):
        # The OpenRouter usage.cost accumulator must NOT feed the chrome bar:
        # a non-Nous session (no header → None) reports no cost even when the
        # OpenRouter accumulator has a value.
        assert nous_header_cost_usd(_FakeAgent(actual=0.42)) is None

    def test_no_header_is_none(self):
        assert nous_header_cost_usd(_FakeAgent()) is None

    def test_negative_delta_clamped(self):
        # A mid-session top-up makes the delta negative — never show negative.
        assert nous_header_cost_usd(_FakeAgent(credits_micros=-50_000)) == 0.0

    def test_agent_without_credits_method_is_none(self):
        agent = SimpleNamespace(session_actual_cost_usd=0.42)
        assert nous_header_cost_usd(agent) is None


# ── Nous header fixture → real accumulator (full _capture_credits path) ─────


def _nous_headers(remaining_micros: int) -> dict:
    return {
        "x-nous-credits-version": "1",
        "x-nous-credits-remaining-micros": str(remaining_micros),
        "x-nous-credits-remaining-usd": f"{remaining_micros / 1_000_000:.2f}",
        "x-nous-credits-subscription-micros": str(remaining_micros),
        "x-nous-credits-subscription-usd": f"{remaining_micros / 1_000_000:.2f}",
        "x-nous-credits-rollover-micros": "0",
        "x-nous-credits-purchased-micros": "0",
        "x-nous-credits-purchased-usd": "0.00",
        "x-nous-credits-denominator-kind": "none",
        "x-nous-credits-paid-access": "true",
        "x-nous-credits-as-of-ms": "1717000000000",
    }


def _bare_nous_agent():
    """Minimal AIAgent shell exercising the real _capture_credits path."""
    from run_agent import AIAgent

    agent = object.__new__(AIAgent)
    agent.provider = "nous"
    agent._credits_state = None
    agent._credits_session_start_micros = None
    agent.notice_callback = None
    agent.notice_clear_callback = None
    agent.session_actual_cost_usd = None
    return agent


class TestNousHeaderAccumulation:
    def test_headers_accumulate_into_real_session_cost(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEV_CREDITS_FIXTURE", raising=False)
        agent = _bare_nous_agent()

        # First response latches the session-start balance ($10.00).
        agent._capture_credits(SimpleNamespace(headers=_nous_headers(10_000_000)))
        assert real_session_cost_usd(agent) == 0.0  # real zero: headers seen, $0 spent

        # Second response: balance dropped by $0.25 → real reported spend.
        agent._capture_credits(SimpleNamespace(headers=_nous_headers(9_750_000)))
        assert real_session_cost_usd(agent) == pytest.approx(0.25)

    def test_no_headers_means_no_cost(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEV_CREDITS_FIXTURE", raising=False)
        agent = _bare_nous_agent()
        agent._capture_credits(SimpleNamespace(headers={"content-type": "application/json"}))
        assert real_session_cost_usd(agent) is None


# ── OpenRouter request param — usage accounting must be requested ────────────


class TestOpenRouterUsageParam:
    def test_profile_extra_body_requests_usage_accounting(self):
        import importlib.util
        from pathlib import Path

        from providers import get_provider_profile

        profile = get_provider_profile("openrouter")
        if profile is None:
            # Force plugin discovery in minimal test envs.
            plugin = Path(__file__).resolve().parents[2] / "plugins" / "model-providers" / "openrouter" / "__init__.py"
            spec = importlib.util.spec_from_file_location("_or_plugin", plugin)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            profile = mod.openrouter

        body = profile.build_extra_body(session_id="s-1")
        assert body["usage"] == {"include": True}

    def test_legacy_transport_path_requests_usage_accounting(self):
        from agent.transports.chat_completions import ChatCompletionsTransport

        transport = ChatCompletionsTransport()
        kwargs = transport.build_kwargs(
            model="anthropic/claude-sonnet-4.6",
            messages=[{"role": "user", "content": "hi"}],
            tools=None,
            is_openrouter=True,
        )
        assert kwargs["extra_body"]["usage"] == {"include": True}

    def test_non_openrouter_does_not_send_usage_param(self):
        from agent.transports.chat_completions import ChatCompletionsTransport

        transport = ChatCompletionsTransport()
        kwargs = transport.build_kwargs(
            model="deepseek-chat",
            messages=[{"role": "user", "content": "hi"}],
            tools=None,
            is_openrouter=False,
        )
        assert "usage" not in (kwargs.get("extra_body") or {})


# ── nous_credits_compact_line — one-liner for the compact /usage page ───────


class TestNousCreditsCompactLine:
    def test_condenses_snapshot_details(self, monkeypatch):
        import agent.account_usage as au

        snap = au.AccountUsageSnapshot(
            provider="nous",
            source="portal-account",
            fetched_at=au._utc_now(),
            title="Nous credits",
            plan="Ultra",
            details=(
                "Subscription credits: $-0.79",
                "Top-up credits: $988.99",
                "Total usable: $988.99",
                "Renews: 2026-06-11T08:14:55.000Z",
                "Manage / top up: https://portal.nousresearch.com/billing",
            ),
        )
        monkeypatch.setattr(au, "_fetch_nous_credits_snapshot", lambda timeout=10.0: snap)
        line = au.nous_credits_compact_line()
        assert line == (
            "Nous credits (Ultra): Total usable: $988.99 · Renews: 2026-06-11T08:14:55.000Z"
        )

    def test_none_when_no_snapshot(self, monkeypatch):
        import agent.account_usage as au

        monkeypatch.setattr(au, "_fetch_nous_credits_snapshot", lambda timeout=10.0: None)
        assert au.nous_credits_compact_line() is None
