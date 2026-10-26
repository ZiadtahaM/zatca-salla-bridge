---
description: Mandatory ZATCA Phase 2 Grounding and Specification Invariants
globs: "*"
alwaysApply: true
---

# ZATCA Phase 2 Grounding Protocol

Scope: Repository Local Rule
Notebook ID: 96f71d9d-7eae-42ff-b3f3-792c06cdf2f1

Antigravity cannot guess business logic, API shapes, or cryptographic architecture for this repository.
All ZATCA rules, UBL 2.1 schemas, CSID onboarding contracts, and hash chaining rules are defined in the ZATCA Notebook.

## 1. Grounding Invariant
Before modifying or creating any code in `src/` or `tests/`:
1. Query the notebook using the `notebook_query` tool or run `nlm notebook query zatca "<question>"` (or `.\validate-spec.ps1 "<question>"`).
2. For zero-latency local development, read `.agents/rules/source-of-truth.md` which contains the compiled master specification.
3. If the notebook does not address a requirement, stop and ask the operator. Never invent fallback logic or synthetic IDs.
