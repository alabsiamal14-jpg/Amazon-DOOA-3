export interface Category {
  id: string;
  name_ar: string;
  slug: string;
  icon?: string;
  count?: number;
  image?: string;
  badge?: string;
}

export interface ProductReview {
  id: string;
  author: string;
  rating: number;
  date: string;
  comment: string;
  verifiedPurchase: boolean;
  avatar?: string;
  title?: string;
  helpfulCount?: number;
  wouldRecommend?: boolean;
}

export interface Product {
  id: string;
  title_ar: string;
  description_ar: string;
  original_price: number;
  discount_price: number | null;
  stock_quantity: number;
  category_id: string;
  category_name: string;
  tags: string[];
  image_url: string;
  gallery_images?: string[];
  video_url?: string;
  video_duration?: number;
  size_or_volume?: string;
  skin_type?: string;
  key_benefits?: string[];
  reviews_list?: ProductReview[];
  badge?: string;
  ai_generated?: boolean;
  rating?: number;
  reviews_count?: number;
  how_to_use?: string;
  ingredients?: string;
  created_at?: string;
  featured?: boolean;
  status?: 'draft' | 'published';
  creator_id?: string;
  contact_phone?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface StoreSettings {
  storeName: string;
  tagline: string;
  whatsappNumber: string;
  currency: string;
  deliveryFee: number;
  freeDeliveryThreshold: number;
  welcomeMessage: string;
}

export interface CustomerOrderInfo {
  customerName: string;
  phone: string;
  email?: string;
  city: string;
  address: string;
  notes: string;
  paymentMethod?: 'cod' | 'bank_transfer' | 'mada';
  deliverySpeed?: 'standard' | 'express';
  deliveryTimePreference?: string;
}

export type OrderStatus = 'pending' | 'processing' | 'shipped' | 'out_for_delivery' | 'delivered' | 'cancelled';

export interface OrderItem {
  product_id: string;
  title_ar: string;
  price: number;
  quantity: number;
  image_url: string;
}

export interface Order {
  id: string;
  order_number: string;
  userId?: string;
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  city: string;
  address: string;
  notes?: string;
  items: OrderItem[];
  subtotal: number;
  discount_amount: number;
  coupon_code?: string;
  delivery_fee: number;
  total_amount: number;
  status: OrderStatus;
  whatsapp_sent: boolean;
  payment_method?: string;
  delivery_speed?: string;
  driver_name?: string;
  driver_phone?: string;
  driver_id?: string;
  cod_collected?: boolean;
  cod_collected_amount?: number;
  driver_notes?: string;
  delivered_at?: string;
  created_at: string;
  updated_at?: string;
}

export interface DriverInfo {
  id: string;
  name: string;
  phone: string;
  city: string;
  vehicle_type?: string;
  active: boolean;
}

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL?: string;
  role: 'customer' | 'user' | 'admin' | 'staff' | 'driver';
  phone?: string;
  city?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: 'superadmin' | 'manager' | 'editor';
  token?: string;
}

export interface AIAnalysisResult {
  title_ar: string;
  description_ar: string;
  category_name: string;
  tags: string[];
  suggested_price?: number;
}

export interface EmployeeSession {
  code: string;
  displayName: string;
  role: 'employee';
  token: string;
}

export type EmployeeDraftSourceType =
  | 'single_image'
  | 'multi_image_single_product'
  | 'batch_images'
  | 'video'
  | 'whatsapp_chat';

export type EmployeeDraftStatus = 'pending_pricing' | 'published';

export interface EmployeeDraft {
  id: string;
  employee_code: string;
  title_ar: string;
  description_ar: string;
  category_id: string;
  category_name: string;
  brand: string;
  size_or_volume: string;
  ingredients: string;
  how_to_use: string;
  tags: string[];
  image_url: string;
  gallery_images: string[];
  source_type: EmployeeDraftSourceType;
  price: number | null;
  original_price: number | null;
  discount_price: number | null;
  pricing_status_label: string;
  status: EmployeeDraftStatus;
  published_product_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BulkImportImageStats {
  original_bytes: number;
  optimized_bytes: number;
  width: number;
  height: number;
  format: 'jpeg';
  saved_percent: number;
}

export type BulkImportSourceType = 'multi_image' | 'zip_archive';
export type BulkImportDraftStatus = 'pending_review' | 'approved_published';

export interface BulkImportDraft {
  id: string;
  batch_id: string;
  source_filename: string;
  source_type: BulkImportSourceType;
  title_ar: string;
  description_ar: string;
  category_id: string;
  category_name: string;
  brand: string;
  size_or_volume: string;
  tags: string[];
  image_url: string;
  image_optimization: BulkImportImageStats;
  price: number | null;
  original_price: number | null;
  discount_price: number | null;
  stock_quantity: number;
  status: BulkImportDraftStatus;
  published_product_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type SmartAssistantSourceType = 'multi_image' | 'zip_archive' | 'cropped_from_batch';
export type SmartAssistantDraftStatus = 'pending_review' | 'approved_published';

export interface SmartAssistantStagedMedia {
  id: string;
  batch_id: string;
  filename: string;
  source_type: 'multi_image' | 'zip_archive';
  image_url: string;
  image_hash: string;
  dhash: string;
  image_optimization: BulkImportImageStats;
  analyzed: boolean;
  created_at: string;
}

export interface SmartAssistantDraft {
  id: string;
  batch_id: string;
  source_filename: string;
  source_type: SmartAssistantSourceType;
  title_ar: string;
  description_ar: string;
  category_id: string;
  category_name: string;
  product_type: string;
  brand: string;
  size_or_volume: string;
  visual_details: string;
  tags: string[];
  image_url: string;
  gallery_images: string[];
  image_hashes: string[];
  dhashes: string[];
  image_optimization: BulkImportImageStats;
  enhanced: boolean;
  duplicate_group_id: string | null;
  price: number | null;
  original_price: number | null;
  discount_price: number | null;
  stock_quantity: number;
  status: SmartAssistantDraftStatus;
  published_product_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SmartAssistantDuplicateGroup {
  group_id: string;
  reason: string;
  draft_ids: string[];
}

export interface SmartAssistantChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actionExecuted?: string;
  affectedCount?: number;
  timestamp: string;
}

export type EngineeringScanScope =
  | 'comprehensive'
  | 'security'
  | 'ui_design'
  | 'performance';

export type EngineeringFindingCategory =
  | 'confirmed_issue'
  | 'potential_issue'
  | 'improvement'
  | 'verified_fixed';

export type EngineeringSeverity = 'critical' | 'high' | 'medium' | 'low';

export type EngineeringDomain =
  | 'errors'
  | 'ui_ux'
  | 'mobile'
  | 'performance'
  | 'firebase'
  | 'auth_rbac'
  | 'security'
  | 'commerce_flow'
  | 'data_integrity';

export type EngineeringRuntimeLayer =
  | 'server'
  | 'client'
  | 'shared'
  | 'config_rules'
  | 'unreferenced';

export type EngineeringReachability =
  | 'reachable_from_client'
  | 'reachable_from_server'
  | 'reachable_from_both'
  | 'unreachable_or_dead'
  | 'config_or_rules';

export type EngineeringDiagnosisType =
  | 'confirmed_vulnerability'
  | 'confirmed_bug'
  | 'suspected_needs_test'
  | 'design_or_perf_improvement'
  | 'verified_control';

export interface EngineeringReverificationResult {
  checked_at: string;
  mode: 'disk_live' | 'proposal_simulation';
  proposal_id?: string | null;
  disappeared: boolean;
  summary_ar: string;
  details?: string;
}

export interface EngineeringFirestoreRuleOp {
  verb: string;
  expression: string;
  is_open_public: boolean;
  requires_auth: boolean;
  role_guard: string | null;
  ownership_guard: string | null;
  field_validation: boolean;
}

export interface EngineeringFirestoreRuleNode {
  path: string;
  parent_path: string | null;
  depth: number;
  line: number;
  operations: EngineeringFirestoreRuleOp[];
  nested_children: string[];
}

export interface EngineeringEvidenceRef {
  file: string;
  line?: number;
  snippet?: string;
  verified_from_disk: boolean;
}

export interface EngineeringFinding {
  id: string;
  rule_key: string;
  scan_id: string;
  scope: EngineeringScanScope;
  domain: EngineeringDomain;
  category: EngineeringFindingCategory;
  severity: EngineeringSeverity;
  diagnosis_type?: EngineeringDiagnosisType;
  confidence_score?: number;
  confidence_reason_ar?: string;
  runtime_layer?: EngineeringRuntimeLayer;
  reachability?: EngineeringReachability;
  import_chain?: string[];
  needs_runtime_test?: boolean;
  runtime_test_hint_ar?: string;
  last_reverification?: EngineeringReverificationResult | null;
  title_ar: string;
  description_ar: string;
  root_cause_ar: string;
  recommended_solution_ar: string;
  evidence: EngineeringEvidenceRef[];
  affected_files: string[];
  status: 'open' | 'proposal_ready' | 'approved' | 'applied' | 'failed' | 'dismissed';
  proposal_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EngineeringFileDiff {
  file_path: string;
  original_excerpt: string;
  proposed_excerpt: string;
  diff_preview: string;
  verified_match: boolean;
}

export interface EngineeringExecutionReport {
  success: boolean;
  summary_ar: string;
  files_modified: string[];
  typecheck_passed: boolean;
  tests_passed: boolean | null;
  command_output: string;
  executed_at: string;
  rollback_available: boolean;
}

export interface EngineeringPatchProposal {
  id: string;
  finding_id: string | null;
  title_ar: string;
  rationale_ar: string;
  affected_files: string[];
  file_diffs: EngineeringFileDiff[];
  verification_command: 'typecheck' | 'tests' | 'typecheck_and_tests';
  status: 'pending_approval' | 'approved' | 'applied' | 'failed' | 'rejected' | 'rolled_back';
  approved_by: string | null;
  approved_at: string | null;
  applied_by: string | null;
  applied_at: string | null;
  execution_report: EngineeringExecutionReport | null;
  created_at: string;
  updated_at: string;
}

export interface EngineeringScanReport {
  id: string;
  scope: EngineeringScanScope;
  started_at: string;
  completed_at: string;
  files_inspected_count: number;
  inspected_files: string[];
  inaccessible_sources: string[];
  layer_breakdown?: {
    server: number;
    client: number;
    shared: number;
    config_rules: number;
    unreferenced: number;
  };
  firestore_rules_parsed_paths?: number;
  suppressed_false_positives_count?: number;
  suppressed_notes_ar?: string[];
  summary_ar: string;
  counts: {
    confirmed_issue: number;
    potential_issue: number;
    improvement: number;
    verified_fixed: number;
  };
  finding_ids: string[];
}

export interface EngineeringAuditLogEntry {
  id: string;
  action:
    | 'scan_executed'
    | 'proposal_created'
    | 'proposal_approved'
    | 'proposal_rejected'
    | 'fix_applied'
    | 'fix_failed'
    | 'fix_rolled_back'
    | 'verification_run'
    | 'chat_analyzed';
  actor: string;
  target_id: string;
  summary_ar: string;
  affected_files: string[];
  success: boolean;
  details?: string;
  timestamp: string;
}

export interface EngineeringChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  evidence_files?: string[];
  uninspected_notes?: string[];
  proposal_id?: string | null;
  timestamp: string;
}


