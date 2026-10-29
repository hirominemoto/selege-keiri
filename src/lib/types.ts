export type Company = {
  id: string;
  name: string;
  honorific: string;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  department: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  send_method: "post" | "email";
  payment_due_months: number;
  payment_due_day: number | null;
  note: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type Contract = {
  id: string;
  company_id: string;
  name: string;
  cohort: string | null;
  kind: "monthly" | "on_demand" | "one_time";
  quantity: number;
  unit_price: number;
  taxable: boolean;
  service_month_offset: 0 | 1;
  total_count: number | null;
  count_unit: "回" | "か月";
  base_count: number;
  legacy_last_service_month: string | null; // 旧Excelで請求済みの最後の「◯月分」
  start_month: string | null;
  end_month: string | null;
  status: "active" | "paused" | "ended";
  description_template: string | null;
  note: string | null;
  version: number;
};
