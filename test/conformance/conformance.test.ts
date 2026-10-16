import { FakeAdapter, runAdapterConformanceSuite } from "./index.js";

runAdapterConformanceSuite("FakeAdapter (in-tree)", () => new FakeAdapter());
