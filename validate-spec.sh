#!/usr/bin/env bash
# validate-spec.sh - NotebookLM Grounding & Spec Verification Lever
GUARD_SCRIPT="C:/Users/DevUser/.gemini/config/hooks/notebook_grounding_guard.py"

if [ "$1" == "--status" ]; then
    python "$GUARD_SCRIPT" --status
    exit $?
fi

if [ "$1" == "--compile" ]; then
    python "$GUARD_SCRIPT" --compile-spec
    exit $?
fi

if [ "$1" == "--bypass" ]; then
    python "$GUARD_SCRIPT" --bypass "${2:-Manual emergency bypass}"
    exit $?
fi

if [ -z "$1" ]; then
    echo "Usage: ./validate-spec.sh '<question to verify against NotebookLM>'"
    echo "       ./validate-spec.sh --status"
    echo "       ./validate-spec.sh --compile"
    echo "       ./validate-spec.sh --bypass '<reason>'"
    exit 1
fi

python "$GUARD_SCRIPT" --validate "$1"
exit $?
