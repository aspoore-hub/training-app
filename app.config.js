const appJson = require("./app.json");

module.exports = ({ config }) => ({
  ...config,
  ...appJson.expo,
  extra: {
    ...appJson.expo.extra,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  },
});
