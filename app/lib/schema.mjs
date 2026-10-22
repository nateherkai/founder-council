// JSON schema helpers shared by the Chair's structured output stages.
export const S = {
  str: { type: "string" },
  num: { type: "number" },
  int: { type: "integer" },
  bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
  enum: (...v) => ({ type: "string", enum: v }),
};
