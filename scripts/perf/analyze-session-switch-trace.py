#!/usr/bin/env python3
"""Summarize session-switch-relevant timing from a Chrome JSON trace.

The parser is streaming and uses only the Python standard library, so traces
hundreds of megabytes large do not need to be expanded or loaded into memory.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import pathlib
import statistics
from collections import Counter, defaultdict
from typing import Any, Iterator, TextIO


TARGET_EVENT_NAMES = {
    "ParseHTML",
    "UpdateLayoutTree",
    "Layout",
    "MinorGC",
    "MajorGC",
    "V8.GC_MINOR",
    "V8.GC_MAJOR",
}
USER_TIMING_NAMES = {
    "yuri.session-switch.highlight-latency",
    "yuri.session-switch.content-latency",
}


def open_trace(path: pathlib.Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return path.open("rt", encoding="utf-8", errors="replace")


def iter_trace_events(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    decoder = json.JSONDecoder()
    with open_trace(path) as stream:
        buffer = ""
        array_started = False
        eof = False

        while not eof:
            chunk = stream.read(1024 * 1024)
            eof = chunk == ""
            buffer += chunk

            if not array_started:
                marker = buffer.find('"traceEvents"')
                if marker < 0:
                    if eof:
                        return
                    buffer = buffer[-64:]
                    continue
                opening = buffer.find("[", marker)
                if opening < 0:
                    if eof:
                        return
                    buffer = buffer[marker:]
                    continue
                buffer = buffer[opening + 1 :]
                array_started = True

            offset = 0
            while True:
                while offset < len(buffer) and buffer[offset] in " \r\n\t,":
                    offset += 1
                if offset >= len(buffer):
                    buffer = ""
                    break
                if buffer[offset] == "]":
                    return
                try:
                    value, end = decoder.raw_decode(buffer, offset)
                except json.JSONDecodeError:
                    buffer = buffer[offset:]
                    break
                offset = end
                if isinstance(value, dict):
                    yield value

            if eof:
                return


def event_duration(event: dict[str, Any]) -> float:
    duration = event.get("dur")
    return float(duration) if isinstance(duration, (int, float)) else 0.0


def is_click_dispatch(event: dict[str, Any]) -> bool:
    if event.get("name") != "EventDispatch" or event.get("ph") != "X":
        return False
    data = event.get("args", {}).get("data", {})
    return data.get("type") == "click"


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[index]


def milliseconds(value_us: float | None) -> float | None:
    if value_us is None:
        return None
    return round(value_us / 1000.0, 2)


def summarize(path: pathlib.Path) -> dict[str, Any]:
    clicks_by_thread: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    targets_by_thread: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    run_tasks_by_thread: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    user_timings: dict[str, list[float]] = defaultdict(list)

    for event in iter_trace_events(path):
        pid = event.get("pid")
        tid = event.get("tid")
        if not isinstance(pid, int) or not isinstance(tid, int):
            continue
        thread = (pid, tid)
        name = event.get("name")

        if is_click_dispatch(event):
            clicks_by_thread[thread].append(event)
        if name in TARGET_EVENT_NAMES and event.get("ph") == "X":
            targets_by_thread[thread].append(event)
        if name == "RunTask" and event.get("ph") == "X":
            run_tasks_by_thread[thread].append(event)
        if name in USER_TIMING_NAMES:
            duration = event_duration(event)
            if duration > 0:
                user_timings[str(name)].append(duration)

    if not clicks_by_thread:
        raise RuntimeError("No click EventDispatch slices found in trace")

    main_thread = max(
        clicks_by_thread,
        key=lambda thread: sum(event_duration(event) for event in clicks_by_thread[thread]),
    )
    clicks = sorted(clicks_by_thread[main_thread], key=lambda event: float(event.get("ts", 0)))
    click_durations = [event_duration(event) for event in clicks]
    long_tasks = [
        event_duration(event)
        for event in run_tasks_by_thread.get(main_thread, [])
        if event_duration(event) >= 50_000
    ]

    click_windows = [
        (float(click.get("ts", 0)), float(click.get("ts", 0)) + event_duration(click))
        for click in clicks
    ]
    target_totals: Counter[str] = Counter()
    for event in targets_by_thread.get(main_thread, []):
        start = float(event.get("ts", 0))
        end = start + event_duration(event)
        if any(start >= click_start and end <= click_end for click_start, click_end in click_windows):
            target_totals[str(event.get("name"))] += event_duration(event)

    user_timing_summary: dict[str, Any] = {}
    for name, values in user_timings.items():
        user_timing_summary[name] = {
            "samples": len(values),
            "median_ms": milliseconds(statistics.median(values)),
            "p95_ms": milliseconds(percentile(values, 0.95)),
            "max_ms": milliseconds(max(values)),
        }

    return {
        "trace": str(path),
        "renderer_main_thread": {"pid": main_thread[0], "tid": main_thread[1]},
        "clicks": {
            "samples": len(click_durations),
            "durations_ms": [milliseconds(value) for value in click_durations],
            "median_ms": milliseconds(statistics.median(click_durations)),
            "p95_ms": milliseconds(percentile(click_durations, 0.95)),
            "max_ms": milliseconds(max(click_durations)),
        },
        "long_tasks": {
            "samples": len(long_tasks),
            "p95_ms": milliseconds(percentile(long_tasks, 0.95)),
            "max_ms": milliseconds(max(long_tasks)) if long_tasks else None,
        },
        "click_window_main_thread_work_ms": {
            name: milliseconds(duration)
            for name, duration in sorted(target_totals.items())
        },
        "user_timings": user_timing_summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()

    result = summarize(args.trace.expanduser().resolve())
    payload = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    print(payload, end="")


if __name__ == "__main__":
    main()
