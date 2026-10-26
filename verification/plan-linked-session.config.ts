import collection from './plan-collection.config.ts';
export default {...collection,test:{...collection.test,include:[...collection.test.include,'verification/plan-linked-session-real-roundtrip.test.tsx']}};
