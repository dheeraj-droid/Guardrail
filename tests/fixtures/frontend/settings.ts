export const getAge = (u: any) => u.age;        // property access on mutated field
const dynamicKey = 'age';
const { [dynamicKey]: dynamic } = {} as any;    // computed — must NOT match
