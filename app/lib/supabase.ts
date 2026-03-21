import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://wfwsmwxakhyxobytszoq.supabase.co";
const supabaseAnonKey = "sb_publishable_0MBDxmVGZHFnjWX79QzKlw_x6sT1w4N";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);