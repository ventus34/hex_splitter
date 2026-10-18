import { setTimeout } from 'node:timers/promises';

// Playwright's waitForFunction polls the returned Promise as truthy; use evaluate
// for predicates that need to await IndexedDB before deciding whether to retry.
export async function waitForAsyncPageCondition(page, predicate, arg, timeout = 8000) {
    const deadline = Date.now() + timeout;
    do {
        if (await page.evaluate(predicate, arg)) return;
        await setTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`Async browser condition did not become true within ${timeout} ms.`);
}
