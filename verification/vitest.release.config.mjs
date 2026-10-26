// Explicit current-core subset; never represented as the historical full suite.
export default {
  "test": {
    "css": true,
    "environment": "jsdom",
    "include": [
      "verification/local-plan-walkthrough.test.tsx",
      "verification/bounded-transport.test.ts",
      "verification/inventory-schedules.test.tsx",
      "verification/pdf-text-find.test.tsx",
      "verification/pdf-page-reader.test.tsx",
      "verification/pdf-annotations.test.tsx",
      "verification/manual-plan-host.test.tsx",
      "verification/pdf-open-navigation.test.tsx",
      "verification/pdf-open-shell-receiver.test.tsx",
      "verification/pdf-open-component-convergence.test.tsx",
      "verification/pdf-image-binding.test.tsx",
      "verification/pdf-store-scope.test.tsx"
    ],
    "maxWorkers": 1,
    "watch": false
  }
};
