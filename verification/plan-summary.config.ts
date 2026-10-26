// Deliberately excludes the default broad test configuration and HTTP/backend lanes.
export default {test:{css:true,environment:'jsdom',include:['verification/local-plan-walkthrough.test.tsx'],maxWorkers:1,watch:false}};
