# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This repository is an empty scaffold. It contains only a placeholder README.md and a .gitignore — no source code, build system, dependencies, or tests exist yet. The project's language, framework, and purpose have not been decided (the .gitignore covers both Node.js and Python patterns, so either stack is plausible).

## When Code Is Added

Update this file once the project takes shape. At minimum, document:

- Build, lint, and test commands (including how to run a single test)
- The high-level architecture once there are multiple modules interacting

## Notes

- The project is named "Guardrail" (GitHub remote: dheeraj-droid/Guardrail). The local directory is still spelled "GaurdRail" — use "Guardrail" in code, docs, and configuration, but don't assume the folder path matches.
- `.env` files are gitignored except `.env.example`; put secret placeholders there.
