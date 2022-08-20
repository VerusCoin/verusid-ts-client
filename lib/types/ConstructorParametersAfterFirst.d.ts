export declare type RemoveFirstFromTuple<T extends unknown[]> = T extends [infer H, ...infer R] ? R : T;
export declare type ConstructorParametersAfterFirst<F extends new (...args: any) => any> = RemoveFirstFromTuple<ConstructorParameters<F>>;
