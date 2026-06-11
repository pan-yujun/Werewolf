"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UserCircle, Key, SignOut, ShareNetwork, Copy, CaretDown, Check, ArrowRight, Eye, EyeSlash, CreditCard, Minus, Plus, Download, Upload } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  clearApiKeys,
  getDashscopeApiKey,
  getFetchedModels,
  getGeneratorModel,
  getMinimaxApiKey,
  getMinimaxGroupId,
  getMimoApiKey,
  getModelscopeApiKey,
  getVolcengineApiKey,
  getSelectedModels,
  getSummaryModel,
  getReviewModel,
  getZenmuxApiKey,
  getValidatedZenmuxKey,
  getValidatedDashscopeKey,
  getValidatedMimoKey,
  getValidatedModelscopeKey,
  getValidatedVolcengineKey,
  setGeneratorModel,
  setMinimaxApiKey,
  setMinimaxGroupId,
  setMimoApiKey,
  setModelscopeApiKey,
  setVolcengineApiKey,
  setSelectedModels,
  setSummaryModel,
  setReviewModel,
  setZenmuxApiKey,
  setDashscopeApiKey,
  setCustomKeyEnabled,
  setFetchedModelsForProvider,
  setValidatedZenmuxKey,
  setValidatedDashscopeKey,
  setValidatedMimoKey,
  setValidatedModelscopeKey,
  setValidatedVolcengineKey,
  isCustomKeyEnabled as getCustomKeyEnabled,
} from "@/lib/api-keys";
import { getModelLogoPath } from "@/lib/model-logo";
import { supabase } from "@/lib/supabase";
import { exportData, importData, getDataSummary } from "@/lib/data-migration";
import { REFERRAL_BONUS_ENABLED, SPRING_CAMPAIGN_ENABLED, REDEMPTION_CODE_ENABLED } from "@/lib/welfare-config";
import {
  ALL_MODELS,
  AVAILABLE_MODELS,
  DASHSCOPE_VALIDATION_MODEL,
  GENERATOR_MODEL,
  MIMO_VALIDATION_MODEL,
  MODELSCOPE_VALIDATION_MODEL,
  VOLCENGINE_VALIDATION_MODEL,
  ZENMUX_VALIDATION_MODEL,
  SUMMARY_MODEL,
  REVIEW_MODEL,
  filterPlayerModels,
  type ModelRef,
} from "@/types/game";
import type { SpringCampaignSnapshot } from "@/lib/spring-campaign";

export interface UserProfileContentProps {
  email?: string | null;
  credits?: number | null;
  springCampaign?: SpringCampaignSnapshot | null;
  referralCode?: string | null;
  totalReferrals?: number | null;
  onChangePassword: () => void;
  onShareInvite: () => void;
  onSignOut: () => void | Promise<void>;
  onRedeemCode?: (code: string) => Promise<{
    success: boolean;
    credits?: number;
    creditsGranted?: number;
    error?: string;
  }>;
  onCustomKeyEnabledChange?: (value: boolean) => void;
  onCreditsChange?: () => void;
  defaultTab?: string;
  /** Called after custom keys are saved successfully. Used by modal to close itself. */
  onSave?: () => void;
}

export function UserProfileContent({
  email,
  credits,
  springCampaign,
  referralCode,
  totalReferrals,
  onChangePassword,
  onShareInvite,
  onSignOut,
  onRedeemCode,
  onCustomKeyEnabledChange,
  onCreditsChange,
  defaultTab = "profile",
  onSave,
}: UserProfileContentProps) {
  const t = useTranslations();
  const [zenmuxKey, setZenmuxKeyState] = useState("");
  const [dashscopeKey, setDashscopeKeyState] = useState("");
  const [mimoKey, setMimoKeyState] = useState("");
  const [modelscopeKey, setModelscopeKeyState] = useState("");
  const [volcengineKey, setVolcengineKeyState] = useState("");
  const [minimaxKey, setMinimaxKeyState] = useState("");
  const [minimaxGroupId, setMinimaxGroupIdState] = useState("");
  const [showZenmuxKey, setShowZenmuxKey] = useState(false);
  const [showDashscopeKey, setShowDashscopeKey] = useState(false);
  const [showMimoKey, setShowMimoKey] = useState(false);
  const [showModelscopeKey, setShowModelscopeKey] = useState(false);
  const [showVolcengineKey, setShowVolcengineKey] = useState(false);
  const [showMinimaxKey, setShowMinimaxKey] = useState(false);
  const [showMinimaxGroupId, setShowMinimaxGroupId] = useState(false);
  const [isCustomKeyEnabled, setIsCustomKeyEnabled] = useState(false);
  const [selectedModels, setSelectedModelsState] = useState<string[]>([]);
  const [generatorModel, setGeneratorModelState] = useState("");
  const [summaryModel, setSummaryModelState] = useState("");
  const [reviewModel, setReviewModelState] = useState("");
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [isValidatingZenmux, setIsValidatingZenmux] = useState(false);
  const [isValidatingDashscope, setIsValidatingDashscope] = useState(false);
  const [isValidatingMimo, setIsValidatingMimo] = useState(false);
  const [isValidatingModelscope, setIsValidatingModelscope] = useState(false);
  const [isValidatingVolcengine, setIsValidatingVolcengine] = useState(false);
  const [validatedKeys, setValidatedKeys] = useState<{ zenmux: string; dashscope: string; mimo: string; modelscope: string; volcengine: string }>({
    zenmux: "",
    dashscope: "",
    mimo: "",
    modelscope: "",
    volcengine: "",
  });
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
  const [isFetchingModels, setIsFetchingModels] = useState<Record<string, boolean>>({});
  const [expandedModelList, setExpandedModelList] = useState<Record<string, boolean>>({});
  const [verifiedModels, setVerifiedModels] = useState<Record<string, Record<string, boolean>>>({});
  const [isVerifyingModels, setIsVerifyingModels] = useState<Record<string, boolean>>({});
  const [purchaseQuantity, setPurchaseQuantity] = useState(10);
  const [purchaseQuantityInput, setPurchaseQuantityInput] = useState("10");
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [redeemCodeInput, setRedeemCodeInput] = useState("");
  const [isRedeeming, setIsRedeeming] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileActionGridClassName = REFERRAL_BONUS_ENABLED
    ? "grid grid-cols-2 gap-2"
    : "grid grid-cols-1 gap-2";
  const shouldShowSpringCampaignQuota = SPRING_CAMPAIGN_ENABLED && springCampaign?.active;
  const shouldShowSpringCampaignStatus = SPRING_CAMPAIGN_ENABLED;

  const displayCredits = useMemo(() => {
    if (credits === null || credits === undefined) return t("userProfile.empty");
    return `${credits}`;
  }, [credits, t]);

  useEffect(() => {
    let mounted = true;

    // Load keys from localStorage first
    let z = getZenmuxApiKey();
    let d = getDashscopeApiKey();
    let m = getMimoApiKey();
    let ms = getModelscopeApiKey();
    let ve = getVolcengineApiKey();
    const nextMinimaxKey = getMinimaxApiKey();
    const nextMinimaxGroupId = getMinimaxGroupId();
    const nextSelectedModels = getSelectedModels();
    const nextGeneratorModel = getGeneratorModel();
    const nextSummaryModel = getSummaryModel();
    const nextReviewModel = getReviewModel();
    const storedCustomEnabled = getCustomKeyEnabled();

    if (mounted) {
      setZenmuxKeyState(z);
      setDashscopeKeyState(d);
      setMimoKeyState(m);
      setModelscopeKeyState(ms);
      setVolcengineKeyState(ve);
      setMinimaxKeyState(nextMinimaxKey);
      setMinimaxGroupIdState(nextMinimaxGroupId);
      setSelectedModelsState(nextSelectedModels);
      setGeneratorModelState(nextGeneratorModel);
      setSummaryModelState(nextSummaryModel);
      setReviewModelState(nextReviewModel);
      setIsCustomKeyEnabled(storedCustomEnabled);
      setValidatedKeys({
        zenmux: z && getValidatedZenmuxKey() === z ? z : "",
        dashscope: d && getValidatedDashscopeKey() === d ? d : "",
        mimo: m && getValidatedMimoKey() === m ? m : "",
        modelscope: ms && getValidatedModelscopeKey() === ms ? ms : "",
        volcengine: ve && getValidatedVolcengineKey() === ve ? ve : "",
      });
      // Restore fetched models from localStorage
      const storedFetched = getFetchedModels();
      if (Object.keys(storedFetched).length > 0) {
        setFetchedModels(storedFetched);
        const expanded: Record<string, boolean> = {};
        for (const k of Object.keys(storedFetched)) expanded[k] = true;
        setExpandedModelList(expanded);
      }
    }

    // Fetch pre-configured keys from .env.local and fill empty fields
    fetch("/api/preconfigured-keys")
      .then((res) => res.json())
      .then((data) => {
        if (!mounted || !data?.keys) return;
        const pre = data.keys as Record<string, string>;
        let hasNewKey = false;

        if (!z && pre.zenmux) { z = pre.zenmux; setZenmuxKeyState(z); setZenmuxApiKey(z); hasNewKey = true; }
        if (!d && pre.dashscope) { d = pre.dashscope; setDashscopeKeyState(d); setDashscopeApiKey(d); hasNewKey = true; }
        if (!m && pre.mimo) { m = pre.mimo; setMimoKeyState(m); setMimoApiKey(m); hasNewKey = true; }
        if (!ms && pre.modelscope) { ms = pre.modelscope; setModelscopeKeyState(ms); setModelscopeApiKey(ms); hasNewKey = true; }
        if (!nextMinimaxKey && pre.minimax) { setMinimaxKeyState(pre.minimax); setMinimaxApiKey(pre.minimax); }
        if (!nextMinimaxGroupId && pre.minimaxGroupId) { setMinimaxGroupIdState(pre.minimaxGroupId); setMinimaxGroupId(pre.minimaxGroupId); }

        if (hasNewKey && !storedCustomEnabled) {
          setIsCustomKeyEnabled(true);
          setCustomKeyEnabled(true);
        }
      })
      .catch(() => { /* ignore - preconfigured keys are optional */ });

    return () => {
      mounted = false;
    };
  }, []);

  const zenmuxConfigured = Boolean(zenmuxKey.trim());
  const dashscopeConfigured = Boolean(dashscopeKey.trim());
  const mimoConfigured = Boolean(mimoKey.trim());
  const modelscopeConfigured = Boolean(modelscopeKey.trim());
  const volcengineConfigured = Boolean(volcengineKey.trim());  // 火山引擎 Key 是否已填写
  const modelPool = useMemo(() => {
    return ALL_MODELS;
  }, []);
  const defaultModelPool = useMemo(() => {
    return AVAILABLE_MODELS;
  }, []);
  const availableModelPool = useMemo(() => {
    const providers = new Set<ModelRef["provider"]>();
    if (zenmuxConfigured) providers.add("zenmux");
    if (dashscopeConfigured) providers.add("dashscope");
    if (mimoConfigured) providers.add("mimo");
    if (modelscopeConfigured) providers.add("modelscope");
    if (volcengineConfigured) providers.add("volcengine");
    if (providers.size === 0) return [];

    // Start with hardcoded models from ALL_MODELS
    const basePool = modelPool.filter((ref) => providers.has(ref.provider));
    const existingModels = new Set(basePool.map((ref) => `${ref.provider}:${ref.model}`));

    // Merge dynamically fetched models
    const dynamicModels: ModelRef[] = [];
    for (const provider of providers) {
      const fetched = fetchedModels[provider];
      if (!fetched) continue;
      for (const modelId of fetched) {
        const key = `${provider}:${modelId}`;
        if (!existingModels.has(key)) {
          existingModels.add(key);
          dynamicModels.push({ provider, model: modelId });
        }
      }
    }

    const merged = [...basePool, ...dynamicModels];

    // Filter out unverified models when verification results are available
    const hasAnyVerification = Object.keys(verifiedModels).length > 0;
    if (!hasAnyVerification) return merged;

    return merged.filter((ref) => {
      const providerResults = verifiedModels[ref.provider];
      // If no verification results for this provider, keep the model (hardcoded or not yet verified)
      if (!providerResults) return true;
      // If verification results exist, only keep verified models
      return providerResults[ref.model] !== false;
    });
  }, [dashscopeConfigured, mimoConfigured, modelscopeConfigured, volcengineConfigured, modelPool, zenmuxConfigured, fetchedModels, verifiedModels]);
  const defaultAvailableModels = useMemo(() => {
    const providers = new Set<ModelRef["provider"]>();
    if (zenmuxConfigured) providers.add("zenmux");
    if (dashscopeConfigured) providers.add("dashscope");
    if (mimoConfigured) providers.add("mimo");
    if (modelscopeConfigured) providers.add("modelscope");
    if (volcengineConfigured) providers.add("volcengine");
    if (providers.size === 0) return [];
    return defaultModelPool.filter((ref) => providers.has(ref.provider));
  }, [dashscopeConfigured, defaultModelPool, mimoConfigured, modelscopeConfigured, volcengineConfigured, zenmuxConfigured]);
  const playerModelPool = useMemo(() => {
    return filterPlayerModels(availableModelPool);
  }, [availableModelPool]);
  const defaultPlayerModels = useMemo(() => {
    return filterPlayerModels(defaultAvailableModels);
  }, [defaultAvailableModels]);

  useEffect(() => {
    if (!isCustomKeyEnabled) return;
    const availableSet = new Set(availableModelPool.map((ref) => ref.model));
    const playerSet = new Set(playerModelPool.map((ref) => ref.model));
    setSelectedModelsState((prev) => {
      const filtered = prev.filter((m) => playerSet.has(m));
      if (filtered.length > 0) return filtered;
      return defaultPlayerModels.map((ref) => ref.model).filter((m) => playerSet.has(m));
    });
    setGeneratorModelState((prev) => {
      if (prev && availableSet.has(prev)) return prev;
      if (availableSet.has(GENERATOR_MODEL)) return GENERATOR_MODEL;
      return availableModelPool[0]?.model ?? "";
    });
    setSummaryModelState((prev) => {
      if (prev && availableSet.has(prev)) return prev;
      if (availableSet.has(SUMMARY_MODEL)) return SUMMARY_MODEL;
      return availableModelPool[0]?.model ?? "";
    });
    setReviewModelState((prev) => {
      if (prev && availableSet.has(prev)) return prev;
      if (availableSet.has(REVIEW_MODEL)) return REVIEW_MODEL;
      return availableModelPool[0]?.model ?? "";
    });
  }, [availableModelPool, defaultPlayerModels, isCustomKeyEnabled, playerModelPool]);

  const selectedModelSummary = useMemo(() => {
    if (selectedModels.length === 0) return t("customKey.selectModel");
    const preview = selectedModels.slice(0, 2).join(t("customKey.modelJoiner"));
    if (selectedModels.length <= 2) return preview;
    return t("customKey.modelCount", { preview, count: selectedModels.length });
  }, [selectedModels, t]);

  const handleCopyReferral = async () => {
    if (!REFERRAL_BONUS_ENABLED || !referralCode) return;
    try {
      await navigator.clipboard.writeText(referralCode);
      toast(t("userProfile.toasts.copySuccess"));
    } catch {
      toast(t("userProfile.toasts.copyFail.title"), {
        description: t("userProfile.toasts.copyFail.description"),
      });
    }
  };

  const handleSignOut = async () => {
    try {
      await onSignOut();
    } finally {
      // no-op — caller handles redirect
    }
  };

  const dataSummary = useMemo(() => getDataSummary(), []);

  const handleExport = () => {
    const { count } = exportData();
    toast(t("dataMigration.exportSuccess", { count }));
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const result = importData(text);
      if (result.error) {
        toast.error(t("dataMigration.importError"), { description: result.error });
      } else {
        toast(t("dataMigration.importSuccess", { imported: result.imported, skipped: result.skipped }));
        // 刷新页面以加载导入的数据
        window.location.reload();
      }
    };
    reader.onerror = () => {
      toast.error(t("dataMigration.importError"), { description: t("dataMigration.fileReadError") });
    };
    reader.readAsText(file);
    // 重置 input 以便重复选择同一文件
    e.target.value = "";
  };

  const handleSaveKeys = () => {
    if (isCustomKeyEnabled) {
      const zenmuxOk = !zenmuxKey.trim() || validatedKeys.zenmux === zenmuxKey.trim();
      const dashscopeOk = !dashscopeKey.trim() || validatedKeys.dashscope === dashscopeKey.trim();
      const mimoOk = !mimoKey.trim() || validatedKeys.mimo === mimoKey.trim();
      const volcengineOk = !volcengineKey.trim() || validatedKeys.volcengine === volcengineKey.trim();
      if (!zenmuxOk || !dashscopeOk || !mimoOk || !volcengineOk) {
        toast(t("customKey.toasts.notValidated"), { description: t("customKey.toasts.notValidatedDesc") });
        return;
      }
    }
    const availableSet = new Set(availableModelPool.map((ref) => ref.model));
    const playerAvailableSet = new Set(playerModelPool.map((ref) => ref.model));
    if (isCustomKeyEnabled && availableSet.size === 0) {
      toast(t("customKey.toasts.needLlmKey"), { description: t("customKey.toasts.needLlmKeyDesc") });
      return;
    }
    const nextSelectedModels = selectedModels.filter((m) => playerAvailableSet.has(m));
    const fallbackGenerator = availableSet.has(GENERATOR_MODEL)
      ? GENERATOR_MODEL
      : availableModelPool[0]?.model ?? "";
    const fallbackSummary = availableSet.has(SUMMARY_MODEL)
      ? SUMMARY_MODEL
      : availableModelPool[0]?.model ?? "";
    const fallbackReview = availableSet.has(REVIEW_MODEL)
      ? REVIEW_MODEL
      : availableModelPool[0]?.model ?? "";
    const nextGeneratorModel = availableSet.has(generatorModel) ? generatorModel : fallbackGenerator;
    const nextSummaryModel = availableSet.has(summaryModel) ? summaryModel : fallbackSummary;
    const nextReviewModel = availableSet.has(reviewModel) ? reviewModel : fallbackReview;
    const removedSelected = selectedModels.filter((m) => !playerAvailableSet.has(m));
    const generatorAdjusted = Boolean(generatorModel) && !availableSet.has(generatorModel);
    const summaryAdjusted = Boolean(summaryModel) && !availableSet.has(summaryModel);
    const reviewAdjusted = Boolean(reviewModel) && !availableSet.has(reviewModel);

    if (
      isCustomKeyEnabled &&
      (availableSet.size === 0 || removedSelected.length > 0 || generatorAdjusted || summaryAdjusted || reviewAdjusted)
    ) {
      toast(t("customKey.toasts.modelsAdjusted"), {
        description: t("customKey.toasts.modelsAdjustedDesc"),
      });
    }
    setZenmuxApiKey(zenmuxKey);
    setDashscopeApiKey(dashscopeKey);
    setMimoApiKey(mimoKey);
    setModelscopeApiKey(modelscopeKey);
    setVolcengineApiKey(volcengineKey);
    setMinimaxApiKey(minimaxKey);
    setMinimaxGroupId(minimaxGroupId);
    setSelectedModels(nextSelectedModels);
    setGeneratorModel(nextGeneratorModel);
    setSummaryModel(nextSummaryModel);
    setReviewModel(nextReviewModel);
    setSelectedModelsState(nextSelectedModels);
    setGeneratorModelState(nextGeneratorModel);
    setSummaryModelState(nextSummaryModel);
    setReviewModelState(nextReviewModel);
    // 通知 WelcomeScreen 等组件刷新模型池（AI 玩家候选、自定义角色下拉列表）
    window.dispatchEvent(new Event("wolfcha-model-pool-changed"));
    toast(t("customKey.toasts.saved"), { description: t("customKey.toasts.savedDesc") });
    onSave?.();
  };

  const validateProviderKey = async (options: {
    provider: "zenmux" | "dashscope" | "mimo" | "modelscope" | "volcengine";
    key: string;
    model: string;
  }) => {
    const { provider, key } = options;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider === "zenmux") {
      headers["X-Zenmux-Api-Key"] = key;
    } else if (provider === "dashscope") {
      headers["X-Dashscope-Api-Key"] = key;
    } else if (provider === "mimo") {
      headers["X-Mimo-Api-Key"] = key;
    } else if (provider === "modelscope") {
      headers["X-Modelscope-Api-Key"] = key;
    } else if (provider === "volcengine") {
      headers["X-Volcengine-Api-Key"] = key;
    }

    const response = await fetch("/api/validate-key", {
      method: "POST",
      headers,
    });

    if (!response.ok) {
      let detail = "";
      try {
        const data = await response.json();
        detail = typeof data?.error === "string" ? data.error : JSON.stringify(data);
      } catch {
        detail = await response.text();
      }
      throw new Error(detail || t("customKey.toasts.validateFailed"));
    }

    const data = await response.json();
    if (!data.valid) {
      throw new Error(data.error || t("customKey.toasts.validateFailed"));
    }
  };

  const handleValidateZenmux = async () => {
    if (isValidatingZenmux || !zenmuxKey.trim()) return;
    setIsValidatingZenmux(true);
    try {
      await validateProviderKey({
        provider: "zenmux",
        key: zenmuxKey.trim(),
        model: ZENMUX_VALIDATION_MODEL,
      });
      setValidatedKeys((prev) => ({ ...prev, zenmux: zenmuxKey.trim() }));
      setValidatedZenmuxKey(zenmuxKey.trim());
    } catch (error) {
      setValidatedKeys((prev) => ({ ...prev, zenmux: "" }));
      if (zenmuxKey.trim() === getValidatedZenmuxKey()) setValidatedZenmuxKey("");
      toast(t("customKey.toasts.validateFailed"), {
        description: t("customKey.toasts.validateFailedDesc"),
      });
    } finally {
      setIsValidatingZenmux(false);
    }
  };

  const handleValidateDashscope = async () => {
    if (isValidatingDashscope || !dashscopeKey.trim()) return;
    setIsValidatingDashscope(true);
    try {
      await validateProviderKey({
        provider: "dashscope",
        key: dashscopeKey.trim(),
        model: DASHSCOPE_VALIDATION_MODEL,
      });
      setValidatedKeys((prev) => ({ ...prev, dashscope: dashscopeKey.trim() }));
      setValidatedDashscopeKey(dashscopeKey.trim());
    } catch (error) {
      setValidatedKeys((prev) => ({ ...prev, dashscope: "" }));
      if (dashscopeKey.trim() === getValidatedDashscopeKey()) setValidatedDashscopeKey("");
      toast(t("customKey.toasts.validateFailed"), {
        description: t("customKey.toasts.validateFailedDesc"),
      });
    } finally {
      setIsValidatingDashscope(false);
    }
  };

  const handleValidateMimo = async () => {
    if (isValidatingMimo || !mimoKey.trim()) return;
    setIsValidatingMimo(true);
    try {
      await validateProviderKey({
        provider: "mimo",
        key: mimoKey.trim(),
        model: MIMO_VALIDATION_MODEL,
      });
      setValidatedKeys((prev) => ({ ...prev, mimo: mimoKey.trim() }));
      setValidatedMimoKey(mimoKey.trim());
    } catch (error) {
      setValidatedKeys((prev) => ({ ...prev, mimo: "" }));
      if (mimoKey.trim() === getValidatedMimoKey()) setValidatedMimoKey("");
      toast(t("customKey.toasts.validateFailed"), {
        description: t("customKey.toasts.validateFailedDesc"),
      });
    } finally {
      setIsValidatingMimo(false);
    }
  };

  const handleValidateModelscope = async () => {
    if (isValidatingModelscope || !modelscopeKey.trim()) return;
    setIsValidatingModelscope(true);
    try {
      await validateProviderKey({
        provider: "modelscope",
        key: modelscopeKey.trim(),
        model: MODELSCOPE_VALIDATION_MODEL,
      });
      setValidatedKeys((prev) => ({ ...prev, modelscope: modelscopeKey.trim() }));
      setValidatedModelscopeKey(modelscopeKey.trim());
    } catch (error) {
      setValidatedKeys((prev) => ({ ...prev, modelscope: "" }));
      if (modelscopeKey.trim() === getValidatedModelscopeKey()) setValidatedModelscopeKey("");
      toast(t("customKey.toasts.validateFailed"), {
        description: t("customKey.toasts.validateFailedDesc"),
      });
    } finally {
      setIsValidatingModelscope(false);
    }
  };

  // 验证火山引擎 API Key — 调用 /api/validate-key 接口测试连通性
  const handleValidateVolcengine = async () => {
    if (isValidatingVolcengine || !volcengineKey.trim()) return;
    setIsValidatingVolcengine(true);
    try {
      await validateProviderKey({
        provider: "volcengine",
        key: volcengineKey.trim(),
        model: VOLCENGINE_VALIDATION_MODEL,
      });
      setValidatedKeys((prev) => ({ ...prev, volcengine: volcengineKey.trim() }));
      setValidatedVolcengineKey(volcengineKey.trim());
    } catch (error) {
      setValidatedKeys((prev) => ({ ...prev, volcengine: "" }));
      if (volcengineKey.trim() === getValidatedVolcengineKey()) setValidatedVolcengineKey("");
      toast(t("customKey.toasts.validateFailed"), {
        description: t("customKey.toasts.validateFailedDesc"),
      });
    } finally {
      setIsValidatingVolcengine(false);
    }
  };

  const handleClearKeys = () => {
    clearApiKeys();
    setZenmuxKeyState("");
    setDashscopeKeyState("");
    setMimoKeyState("");
    setModelscopeKeyState("");
    setVolcengineKeyState("");
    setMinimaxKeyState("");
    setMinimaxGroupIdState("");
    setSelectedModelsState([]);
    setGeneratorModelState(getGeneratorModel());
    setSummaryModelState(getSummaryModel());
    setReviewModelState(getReviewModel());
    setIsCustomKeyEnabled(false);
    setValidatedKeys({ zenmux: "", dashscope: "", mimo: "", modelscope: "", volcengine: "" });
    onCustomKeyEnabledChange?.(false);
    toast(t("customKey.toasts.cleared"));
  };

  const fetchProviderModels = async (provider: string, apiKey: string) => {
    if (!apiKey.trim() || isFetchingModels[provider]) return;
    setIsFetchingModels((prev) => ({ ...prev, [provider]: true }));
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Provider": provider,
      };
      if (apiKey) headers["X-Api-Key"] = apiKey;

      const response = await fetch("/api/list-models", {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const models: string[] = Array.isArray(data?.models) ? data.models : [];

      if (models.length === 0) {
        toast(t("customKey.fetchModels.empty"));
        return;
      }

      setFetchedModels((prev) => ({ ...prev, [provider]: models }));
      setExpandedModelList((prev) => ({ ...prev, [provider]: true }));
      setFetchedModelsForProvider(provider, models);
      toast(t("customKey.fetchModels.success", { count: models.length }));

      // Start verification in background
      verifyProviderModels(provider, apiKey, models);
    } catch (error) {
      console.error(`[fetchProviderModels] ${provider} error:`, error);
      toast(t("customKey.fetchModels.error"), {
        description: String(error),
      });
    } finally {
      setIsFetchingModels((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const verifyProviderModels = async (provider: string, apiKey: string, models: string[]) => {
    setIsVerifyingModels((prev) => ({ ...prev, [provider]: true }));
    try {
      const response = await fetch("/api/verify-models", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Provider": provider,
          ...(apiKey ? { "X-Api-Key": apiKey } : {}),
        },
        body: JSON.stringify({ models }),
      });

      if (!response.ok) {
        console.warn(`[verifyProviderModels] ${provider} verification failed: ${response.status}`);
        return;
      }

      const result = await response.json();
      const results: Record<string, boolean> = result?.results || {};
      setVerifiedModels((prev) => ({ ...prev, [provider]: results }));

      const validCount = Object.values(results).filter(Boolean).length;
      console.log(`[verifyProviderModels] ${provider}: ${validCount}/${models.length} verified`);
    } catch (error) {
      console.warn(`[verifyProviderModels] ${provider} error:`, error);
    } finally {
      setIsVerifyingModels((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const handlePurchase = async () => {
    if (isPurchasing || purchaseQuantity < 10) return;
    setIsPurchasing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        toast(t("customKey.payAsYouGo.error"));
        return;
      }

      const response = await fetch("/api/stripe/payment-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ quantity: purchaseQuantity }),
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast(t("customKey.payAsYouGo.error"));
      }
    } catch {
      toast(t("customKey.payAsYouGo.error"));
    } finally {
      setIsPurchasing(false);
    }
  };

  const handleRedeem = async () => {
    if (isRedeeming || !redeemCodeInput.trim() || !onRedeemCode) return;
    setIsRedeeming(true);
    try {
      const result = await onRedeemCode(redeemCodeInput);
      if (result.success) {
        toast(t("customKey.payAsYouGo.redeemSuccess", { count: result.creditsGranted ?? 5 }));
        setRedeemCodeInput("");
      } else {
        const errorKey = result.error as "invalid_code" | "already_redeemed" | "disabled" | undefined;
        const errorMsg = errorKey && t.has(`customKey.payAsYouGo.redeemError.${errorKey}`)
          ? t(`customKey.payAsYouGo.redeemError.${errorKey}`)
          : t("customKey.payAsYouGo.redeemError.default");
        toast(errorMsg);
      }
    } catch {
      toast(t("customKey.payAsYouGo.redeemError.default"));
    } finally {
      setIsRedeeming(false);
    }
  };

  const totalPrice = (purchaseQuantity * 0.5).toFixed(2);

  return (
    <Tabs defaultValue={defaultTab} key={defaultTab}>
      <TabsList>
        <TabsTrigger value="profile">{t("customKey.tabs.profile")}</TabsTrigger>
        <TabsTrigger value="payAsYouGo">{t("customKey.tabs.payAsYouGo")}</TabsTrigger>
        <TabsTrigger value="custom">{t("customKey.tabs.custom")}</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <div className="space-y-4">
          <div className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-card)] p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t("userProfile.fields.email")}</span>
              <span className="text-[var(--text-primary)]">{email ?? t("userProfile.loggedIn")}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t("userProfile.fields.credits")}</span>
              <span className="text-[var(--text-primary)]">{displayCredits}</span>
            </div>
            {shouldShowSpringCampaignQuota && (
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">{t("userProfile.fields.springQuota")}</span>
                <span className="text-[var(--text-primary)]">
                  {t("userProfile.fields.springQuotaValue", {
                    count: springCampaign.remainingQuota,
                    total: springCampaign.totalQuota,
                  })}
                </span>
              </div>
            )}
            {REFERRAL_BONUS_ENABLED && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">{t("userProfile.fields.referrals")}</span>
                  <span className="text-[var(--text-primary)]">{totalReferrals ?? 0}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-muted)]">{t("userProfile.fields.referralCode")}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--text-primary)]">{referralCode ?? "—"}</span>
                    {referralCode && (
                      <button
                        type="button"
                        onClick={handleCopyReferral}
                        className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={t("userProfile.actions.copy")}
                      >
                        <Copy size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
            {shouldShowSpringCampaignStatus && (
              <p className="text-xs text-[var(--text-muted)] pt-0.5">
                {springCampaign?.active
                  ? t("customKey.springCampaign.active")
                  : t("customKey.springCampaign.ended")}
              </p>
            )}
          </div>

          <div className={profileActionGridClassName}>
            <Button type="button" variant="outline" onClick={onChangePassword} className="gap-2">
              <Key size={16} />
              {t("userProfile.actions.changePassword")}
            </Button>
            {REFERRAL_BONUS_ENABLED && (
              <Button type="button" variant="outline" onClick={onShareInvite} className="gap-2">
                <ShareNetwork size={16} />
                {t("userProfile.actions.shareInvite")}
              </Button>
            )}
          </div>

          <Button type="button" variant="outline" onClick={handleSignOut} className="w-full gap-2">
            <SignOut size={16} />
            {t("userProfile.actions.signOut")}
          </Button>

          {/* Data Migration */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-3 space-y-3">
            <p className="text-xs text-[var(--text-muted)]">
              {t("dataMigration.description")}
            </p>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <span>{t("dataMigration.currentData", { characters: dataSummary.customCharacters, history: dataSummary.gameHistory })}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={handleExport} className="gap-2">
                <Download size={16} />
                {t("dataMigration.export")}
              </Button>
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-2">
                <Upload size={16} />
                {t("dataMigration.import")}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportFile}
            />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="payAsYouGo">
        <div className="space-y-4">
          {REDEMPTION_CODE_ENABLED && (
            <>
              <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.payAsYouGo.purchaseTitle")}</h3>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.payAsYouGo.purchaseDesc")}</p>
                </div>
                <div className="flex justify-center">
                  <img
                    src="/pay.png"
                    alt="Purchase QR Code"
                    className="w-48 h-48 object-contain rounded-lg"
                  />
                </div>
                <a
                  href="https://pay.ldxp.cn/item/j9arl2"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  {t("customKey.payAsYouGo.openPurchaseLink")}
                  <ArrowRight size={14} />
                </a>
              </section>

              <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.payAsYouGo.redeemTitle")}</h3>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.payAsYouGo.redeemHint")}</p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={redeemCodeInput}
                    onChange={(e) => setRedeemCodeInput(e.target.value)}
                    placeholder={t("customKey.payAsYouGo.redeemPlaceholder")}
                    className="flex-1"
                    disabled={isRedeeming}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && redeemCodeInput.trim() && !isRedeeming) {
                        void handleRedeem();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    onClick={() => void handleRedeem()}
                    disabled={isRedeeming || !redeemCodeInput.trim()}
                    className="gap-2"
                  >
                    <CreditCard size={16} />
                    {isRedeeming ? t("customKey.payAsYouGo.redeeming") : t("customKey.payAsYouGo.redeemButton")}
                  </Button>
                </div>
              </section>
            </>
          )}

          <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--text-muted)]">{t("customKey.payAsYouGo.pricePerGame", { price: "0.50" })}</span>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">{t("customKey.payAsYouGo.quantity")}</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newVal = Math.max(10, purchaseQuantity - 1);
                    setPurchaseQuantity(newVal);
                    setPurchaseQuantityInput(newVal.toString());
                  }}
                  disabled={purchaseQuantity <= 10}
                  className="h-9 w-9 p-0"
                >
                  <Minus size={16} />
                </Button>
                <Input
                  type="number"
                  min={10}
                  max={100}
                  value={purchaseQuantityInput}
                  onChange={(e) => {
                    const inputValue = e.target.value;
                    setPurchaseQuantityInput(inputValue);
                    if (inputValue === "") return;
                    const val = parseInt(inputValue, 10);
                    if (!isNaN(val) && val >= 10) {
                      setPurchaseQuantity(Math.min(100, Math.max(10, val)));
                    }
                  }}
                  onBlur={(e) => {
                    const inputValue = e.target.value;
                    if (inputValue === "" || isNaN(parseInt(inputValue, 10))) {
                      setPurchaseQuantityInput("10");
                      setPurchaseQuantity(10);
                    } else {
                      const val = parseInt(inputValue, 10);
                      const clampedVal = Math.min(100, Math.max(10, val));
                      setPurchaseQuantityInput(clampedVal.toString());
                      setPurchaseQuantity(clampedVal);
                    }
                  }}
                  className="h-9 w-20 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newVal = Math.min(100, purchaseQuantity + 1);
                    setPurchaseQuantity(newVal);
                    setPurchaseQuantityInput(newVal.toString());
                  }}
                  disabled={purchaseQuantity >= 100}
                  className="h-9 w-9 p-0"
                >
                  <Plus size={16} />
                </Button>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-[var(--text-muted)]">{t("customKey.payAsYouGo.minQuantity")}</p>
                <p className="text-xs text-[var(--text-muted)] opacity-70">{t("customKey.payAsYouGo.minQuantityHint")}</p>
              </div>
            </div>

            <div className="border-t border-[var(--border-color)] pt-4">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.payAsYouGo.total")}</span>
                <span className="text-lg font-semibold text-[var(--color-gold)]">${totalPrice}</span>
              </div>
              <Button
                type="button"
                onClick={handlePurchase}
                disabled={isPurchasing}
                className="w-full gap-2"
              >
                <CreditCard size={16} />
                {isPurchasing ? t("customKey.payAsYouGo.redirecting") : t("customKey.payAsYouGo.purchase")}
              </Button>
            </div>
          </section>
        </div>
      </TabsContent>

      <TabsContent value="custom">
        <div className="space-y-5">
          {/* 1. Enable custom key */}
          <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.title")}</h3>
                <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.description")}</p>
              </div>
              <Switch
                checked={isCustomKeyEnabled}
                onCheckedChange={(value) => {
                  setIsCustomKeyEnabled(value);
                  setCustomKeyEnabled(value);
                  onCustomKeyEnabledChange?.(value);
                }}
              />
            </div>
          </section>

          {isCustomKeyEnabled && (
            <>
              {/* 2. LLM Keys */}
              <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.llmKey.title")}</h3>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.llmKey.description")}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="zenmux-key" className="text-xs">{t("customKey.zenmux.label")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="zenmux-key"
                      name="wolfcha-zenmux-api-key"
                      type={showZenmuxKey ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("customKey.zenmux.placeholder")}
                      value={zenmuxKey}
                      onChange={(e) => {
                        setZenmuxKeyState(e.target.value);
                        setValidatedKeys((prev) => ({ ...prev, zenmux: "" }));
                      }}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowZenmuxKey((v) => !v)} aria-label={showZenmuxKey ? t("customKey.zenmux.hide") : t("customKey.zenmux.show")}>
                      {showZenmuxKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleValidateZenmux} disabled={isValidatingZenmux || !zenmuxKey.trim() || (!!validatedKeys.zenmux && validatedKeys.zenmux === zenmuxKey.trim())}>
                      {isValidatingZenmux ? t("customKey.validating") : validatedKeys.zenmux && validatedKeys.zenmux === zenmuxKey.trim() ? <Check size={16} className="text-[var(--color-success)]" /> : t("customKey.validate")}
                    </Button>
                  </div>
                  <a href="https://zenmux.ai/invite/DMMBVZ" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border-2 border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-2.5 py-2 transition-all hover:shadow-md">
                    <img src="/sponsor/zenmux.png" alt="" className="h-6 w-6 shrink-0 rounded object-contain" />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-[var(--text-primary)]">{t("customKey.zenmux.get")}</span>
                      <span className="text-[11px] text-[var(--text-muted)] ml-1.5">{t("customKey.zenmux.note")}</span>
                    </div>
                    <ArrowRight size={14} className="shrink-0 text-[var(--color-accent)]" />
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchProviderModels("zenmux", zenmuxKey.trim())}
                    disabled={isFetchingModels.zenmux || !zenmuxKey.trim()}
                  >
                    {isFetchingModels.zenmux ? t("customKey.fetchModels.loading") : t("customKey.fetchModels.button")}
                  </Button>
                  {fetchedModels.zenmux && fetchedModels.zenmux.length > 0 && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={() => setExpandedModelList((prev) => ({ ...prev, zenmux: !prev.zenmux }))}
                      >
                        <CaretDown size={12} className={`transition-transform ${expandedModelList.zenmux ? "" : "-rotate-90"}`} />
                        {t("customKey.fetchModels.available", { count: fetchedModels.zenmux.length })}
                      </button>
                      {expandedModelList.zenmux && (
                        <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 space-y-0.5">
                          {isVerifyingModels.zenmux && <div className="text-xs text-[var(--text-muted)] py-1">{t("customKey.fetchModels.verifying")}</div>}
                          {fetchedModels.zenmux.map((modelId) => {
                            const verified = verifiedModels.zenmux?.[modelId];
                            const unverified = verifiedModels.zenmux && !verified;
                            return (
                              <div key={modelId} className={`flex items-center gap-2 text-xs py-0.5 ${unverified ? "opacity-40 line-through" : "text-[var(--text-secondary)]"}`}>
                                <img src={getModelLogoPath({ provider: "zenmux", model: modelId })} alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span className="truncate flex-1">{modelId}</span>
                                {verified && <span className="text-[var(--color-success)] text-[10px]">✓</span>}
                                {unverified && <span className="text-[var(--text-muted)] text-[10px]">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-[var(--border-color)] pt-3 space-y-2">
                  <Label htmlFor="dashscope-key" className="text-xs">{t("customKey.dashscope.label")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="dashscope-key"
                      name="wolfcha-dashscope-api-key"
                      type={showDashscopeKey ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("customKey.dashscope.placeholder")}
                      value={dashscopeKey}
                      onChange={(e) => {
                        setDashscopeKeyState(e.target.value);
                        setValidatedKeys((prev) => ({ ...prev, dashscope: "" }));
                      }}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowDashscopeKey((v) => !v)} aria-label={showDashscopeKey ? t("customKey.dashscope.hide") : t("customKey.dashscope.show")}>
                      {showDashscopeKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleValidateDashscope} disabled={isValidatingDashscope || !dashscopeKey.trim() || (!!validatedKeys.dashscope && validatedKeys.dashscope === dashscopeKey.trim())}>
                      {isValidatingDashscope ? t("customKey.validating") : validatedKeys.dashscope && validatedKeys.dashscope === dashscopeKey.trim() ? <Check size={16} className="text-[var(--color-success)]" /> : t("customKey.validate")}
                    </Button>
                  </div>
                  <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-2 transition-colors hover:bg-[var(--bg-hover)]">
                    <img src="/sponsor/bailian.png" alt="" className="h-6 w-6 shrink-0 rounded object-contain" />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-[var(--text-primary)]">{t("customKey.dashscope.get")}</span>
                      <span className="text-[11px] text-[var(--text-muted)] ml-1.5">{t("customKey.dashscope.note")}</span>
                    </div>
                    <ArrowRight size={14} className="shrink-0 text-[var(--text-muted)]" />
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchProviderModels("dashscope", dashscopeKey.trim())}
                    disabled={isFetchingModels.dashscope || !dashscopeKey.trim()}
                  >
                    {isFetchingModels.dashscope ? t("customKey.fetchModels.loading") : t("customKey.fetchModels.button")}
                  </Button>
                  {fetchedModels.dashscope && fetchedModels.dashscope.length > 0 && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={() => setExpandedModelList((prev) => ({ ...prev, dashscope: !prev.dashscope }))}
                      >
                        <CaretDown size={12} className={`transition-transform ${expandedModelList.dashscope ? "" : "-rotate-90"}`} />
                        {t("customKey.fetchModels.available", { count: fetchedModels.dashscope.length })}
                      </button>
                      {expandedModelList.dashscope && (
                        <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 space-y-0.5">
                          {isVerifyingModels.dashscope && <div className="text-xs text-[var(--text-muted)] py-1">{t("customKey.fetchModels.verifying")}</div>}
                          {fetchedModels.dashscope.map((modelId) => {
                            const verified = verifiedModels.dashscope?.[modelId];
                            const unverified = verifiedModels.dashscope && !verified;
                            return (
                              <div key={modelId} className={`flex items-center gap-2 text-xs py-0.5 ${unverified ? "opacity-40 line-through" : "text-[var(--text-secondary)]"}`}>
                                <img src={getModelLogoPath({ provider: "dashscope", model: modelId })} alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span className="truncate flex-1">{modelId}</span>
                                {verified && <span className="text-[var(--color-success)] text-[10px]">✓</span>}
                                {unverified && <span className="text-[var(--text-muted)] text-[10px]">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-[var(--border-color)] pt-3 space-y-2">
                  <Label htmlFor="mimo-key" className="text-xs">{t("customKey.mimo.label")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="mimo-key"
                      name="wolfcha-mimo-api-key"
                      type={showMimoKey ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("customKey.mimo.placeholder")}
                      value={mimoKey}
                      onChange={(e) => {
                        setMimoKeyState(e.target.value);
                        setValidatedKeys((prev) => ({ ...prev, mimo: "" }));
                      }}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowMimoKey((v) => !v)} aria-label={showMimoKey ? t("customKey.mimo.hide") : t("customKey.mimo.show")}>
                      {showMimoKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleValidateMimo} disabled={isValidatingMimo || !mimoKey.trim() || (!!validatedKeys.mimo && validatedKeys.mimo === mimoKey.trim())}>
                      {isValidatingMimo ? t("customKey.validating") : validatedKeys.mimo && validatedKeys.mimo === mimoKey.trim() ? <Check size={16} className="text-[var(--color-success)]" /> : t("customKey.validate")}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchProviderModels("mimo", mimoKey.trim())}
                    disabled={isFetchingModels.mimo || !mimoKey.trim()}
                  >
                    {isFetchingModels.mimo ? t("customKey.fetchModels.loading") : t("customKey.fetchModels.button")}
                  </Button>
                  {fetchedModels.mimo && fetchedModels.mimo.length > 0 && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={() => setExpandedModelList((prev) => ({ ...prev, mimo: !prev.mimo }))}
                      >
                        <CaretDown size={12} className={`transition-transform ${expandedModelList.mimo ? "" : "-rotate-90"}`} />
                        {t("customKey.fetchModels.available", { count: fetchedModels.mimo.length })}
                      </button>
                      {expandedModelList.mimo && (
                        <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 space-y-0.5">
                          {isVerifyingModels.mimo && <div className="text-xs text-[var(--text-muted)] py-1">{t("customKey.fetchModels.verifying")}</div>}
                          {fetchedModels.mimo.map((modelId) => {
                            const verified = verifiedModels.mimo?.[modelId];
                            const unverified = verifiedModels.mimo && !verified;
                            return (
                              <div key={modelId} className={`flex items-center gap-2 text-xs py-0.5 ${unverified ? "opacity-40 line-through" : "text-[var(--text-secondary)]"}`}>
                                <img src={getModelLogoPath({ provider: "mimo", model: modelId })} alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span className="truncate flex-1">{modelId}</span>
                                {verified && <span className="text-[var(--color-success)] text-[10px]">✓</span>}
                                {unverified && <span className="text-[var(--text-muted)] text-[10px]">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-[var(--border-color)] pt-3 space-y-2">
                  <Label htmlFor="modelscope-key" className="text-xs">{t("customKey.modelscope.label")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="modelscope-key"
                      name="wolfcha-modelscope-api-key"
                      type={showModelscopeKey ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("customKey.modelscope.placeholder")}
                      value={modelscopeKey}
                      onChange={(e) => {
                        setModelscopeKeyState(e.target.value);
                        setValidatedKeys((prev) => ({ ...prev, modelscope: "" }));
                      }}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowModelscopeKey((v) => !v)} aria-label={showModelscopeKey ? t("customKey.modelscope.hide") : t("customKey.modelscope.show")}>
                      {showModelscopeKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleValidateModelscope} disabled={isValidatingModelscope || !modelscopeKey.trim() || (!!validatedKeys.modelscope && validatedKeys.modelscope === modelscopeKey.trim())}>
                      {isValidatingModelscope ? t("customKey.validating") : validatedKeys.modelscope && validatedKeys.modelscope === modelscopeKey.trim() ? <Check size={16} className="text-[var(--color-success)]" /> : t("customKey.validate")}
                    </Button>
                  </div>
                  <a href="https://modelscope.cn/my/myaccesstoken" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-2 transition-colors hover:bg-[var(--bg-hover)]">
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-[var(--text-primary)]">{t("customKey.modelscope.get")}</span>
                      <span className="text-[11px] text-[var(--text-muted)] ml-1.5">{t("customKey.modelscope.note")}</span>
                    </div>
                    <ArrowRight size={14} className="shrink-0 text-[var(--text-muted)]" />
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchProviderModels("modelscope", modelscopeKey.trim())}
                    disabled={isFetchingModels.modelscope || !modelscopeKey.trim()}
                  >
                    {isFetchingModels.modelscope ? t("customKey.fetchModels.loading") : t("customKey.fetchModels.button")}
                  </Button>
                  {fetchedModels.modelscope && fetchedModels.modelscope.length > 0 && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={() => setExpandedModelList((prev) => ({ ...prev, modelscope: !prev.modelscope }))}
                      >
                        <CaretDown size={12} className={`transition-transform ${expandedModelList.modelscope ? "" : "-rotate-90"}`} />
                        {t("customKey.fetchModels.available", { count: fetchedModels.modelscope.length })}
                      </button>
                      {expandedModelList.modelscope && (
                        <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 space-y-0.5">
                          {isVerifyingModels.modelscope && <div className="text-xs text-[var(--text-muted)] py-1">{t("customKey.fetchModels.verifying")}</div>}
                          {fetchedModels.modelscope.map((modelId) => {
                            const verified = verifiedModels.modelscope?.[modelId];
                            const unverified = verifiedModels.modelscope && !verified;
                            return (
                              <div key={modelId} className={`flex items-center gap-2 text-xs py-0.5 ${unverified ? "opacity-40 line-through" : "text-[var(--text-secondary)]"}`}>
                                <img src={getModelLogoPath({ provider: "modelscope", model: modelId })} alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span className="truncate flex-1">{modelId}</span>
                                {verified && <span className="text-[var(--color-success)] text-[10px]">✓</span>}
                                {unverified && <span className="text-[var(--text-muted)] text-[10px]">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-[var(--border-color)] pt-3 space-y-2">
                  <Label htmlFor="volcengine-key" className="text-xs">{t("customKey.volcengine.label")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="volcengine-key"
                      name="wolfcha-volcengine-api-key"
                      type={showVolcengineKey ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("customKey.volcengine.placeholder")}
                      value={volcengineKey}
                      onChange={(e) => {
                        setVolcengineKeyState(e.target.value);
                        setValidatedKeys((prev) => ({ ...prev, volcengine: "" }));
                      }}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowVolcengineKey((v) => !v)} aria-label={showVolcengineKey ? t("customKey.volcengine.hide") : t("customKey.volcengine.show")}>
                      {showVolcengineKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleValidateVolcengine} disabled={isValidatingVolcengine || !volcengineKey.trim() || (!!validatedKeys.volcengine && validatedKeys.volcengine === volcengineKey.trim())}>
                      {isValidatingVolcengine ? t("customKey.validating") : validatedKeys.volcengine && validatedKeys.volcengine === volcengineKey.trim() ? <Check size={16} className="text-[var(--color-success)]" /> : t("customKey.validate")}
                    </Button>
                  </div>
                  <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-2 transition-colors hover:bg-[var(--bg-hover)]">
                    <img src="/models/doubao.svg" alt="" className="h-6 w-6 shrink-0 rounded object-contain" />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-[var(--text-primary)]">{t("customKey.volcengine.get")}</span>
                      <span className="text-[11px] text-[var(--text-muted)] ml-1.5">{t("customKey.volcengine.note")}</span>
                    </div>
                    <ArrowRight size={14} className="shrink-0 text-[var(--text-muted)]" />
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchProviderModels("volcengine", volcengineKey.trim())}
                    disabled={isFetchingModels.volcengine || !volcengineKey.trim()}
                  >
                    {isFetchingModels.volcengine ? t("customKey.fetchModels.loading") : t("customKey.fetchModels.button")}
                  </Button>
                  {fetchedModels.volcengine && fetchedModels.volcengine.length > 0 && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        onClick={() => setExpandedModelList((prev) => ({ ...prev, volcengine: !prev.volcengine }))}
                      >
                        <CaretDown size={12} className={`transition-transform ${expandedModelList.volcengine ? "" : "-rotate-90"}`} />
                        {t("customKey.fetchModels.available", { count: fetchedModels.volcengine.length })}
                      </button>
                      {expandedModelList.volcengine && (
                        <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 space-y-0.5">
                          {isVerifyingModels.volcengine && <div className="text-xs text-[var(--text-muted)] py-1">{t("customKey.fetchModels.verifying")}</div>}
                          {fetchedModels.volcengine.map((modelId) => {
                            const verified = verifiedModels.volcengine?.[modelId];
                            const unverified = verifiedModels.volcengine && !verified;
                            return (
                              <div key={modelId} className={`flex items-center gap-2 text-xs py-0.5 ${unverified ? "opacity-40 line-through" : "text-[var(--text-secondary)]"}`}>
                                <img src={getModelLogoPath({ provider: "volcengine", model: modelId })} alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span className="truncate flex-1">{modelId}</span>
                                {verified && <span className="text-[var(--color-success)] text-[10px]">✓</span>}
                                {unverified && <span className="text-[var(--text-muted)] text-[10px]">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* 3. Model config */}
              {availableModelPool.length > 0 && (
                <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.modelConfig.title")}</h3>
                    <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.modelConfig.description")}</p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="generator-model" className="text-xs">{t("customKey.modelConfig.generator")}</Label>
                      <Select
                        value={availableModelPool.some((r) => r.model === generatorModel) ? generatorModel : ""}
                        onValueChange={(v) => setGeneratorModelState(v)}
                      >
                        <SelectTrigger id="generator-model"><SelectValue placeholder={t("customKey.selectModel")} /></SelectTrigger>
                        <SelectContent className="max-h-60">
                          {availableModelPool.map((r) => (
                            <SelectItem key={`${r.provider}:${r.model}`} value={r.model} label={r.model} description={r.provider === "zenmux" ? "Zenmux" : r.provider === "dashscope" ? t("customKey.dashscope.short") : r.provider === "mimo" ? "Mimo" : r.provider === "modelscope" ? t("customKey.modelscope.short") : r.provider === "volcengine" ? t("customKey.volcengine.short") : r.provider} icon={getModelLogoPath(r)} />
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="summary-model" className="text-xs">{t("customKey.modelConfig.summary")}</Label>
                      <Select
                        value={availableModelPool.some((r) => r.model === summaryModel) ? summaryModel : ""}
                        onValueChange={(v) => setSummaryModelState(v)}
                      >
                        <SelectTrigger id="summary-model"><SelectValue placeholder={t("customKey.selectModel")} /></SelectTrigger>
                        <SelectContent className="max-h-60">
                          {availableModelPool.map((r) => (
                            <SelectItem key={`${r.provider}:${r.model}`} value={r.model} label={r.model} description={r.provider === "zenmux" ? "Zenmux" : r.provider === "dashscope" ? t("customKey.dashscope.short") : r.provider === "mimo" ? "Mimo" : r.provider === "modelscope" ? t("customKey.modelscope.short") : r.provider === "volcengine" ? t("customKey.volcengine.short") : r.provider} icon={getModelLogoPath(r)} />
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="review-model" className="text-xs">{t("customKey.modelConfig.review")}</Label>
                      <Select
                        value={availableModelPool.some((r) => r.model === reviewModel) ? reviewModel : ""}
                        onValueChange={(v) => setReviewModelState(v)}
                      >
                        <SelectTrigger id="review-model"><SelectValue placeholder={t("customKey.selectModel")} /></SelectTrigger>
                        <SelectContent className="max-h-60">
                          {availableModelPool.map((r) => (
                            <SelectItem key={`${r.provider}:${r.model}`} value={r.model} label={r.model} description={r.provider === "zenmux" ? "Zenmux" : r.provider === "dashscope" ? t("customKey.dashscope.short") : r.provider === "mimo" ? "Mimo" : r.provider === "modelscope" ? t("customKey.modelscope.short") : r.provider === "volcengine" ? t("customKey.volcengine.short") : r.provider} icon={getModelLogoPath(r)} />
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">{t("customKey.modelConfig.candidates")}</Label>
                    <p className="text-xs text-[var(--text-muted)]">{t("customKey.modelConfig.candidatesDesc")}</p>
                    <DropdownMenu open={isModelSelectorOpen} onOpenChange={setIsModelSelectorOpen}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:border-[var(--color-accent)]"
                        >
                          <span className="min-w-0 truncate text-left">{selectedModelSummary}</span>
                          <CaretDown size={16} className={`shrink-0 transition-transform ${isModelSelectorOpen ? "rotate-180" : ""}`} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                        {playerModelPool.map((r) => (
                          <DropdownMenuCheckboxItem
                            key={`${r.provider}:${r.model}`}
                            checked={selectedModels.includes(r.model)}
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={(checked) =>
                              setSelectedModelsState((prev) =>
                                checked ? [...prev, r.model] : prev.filter((m) => m !== r.model)
                              )
                            }
                          >
                            <img src={getModelLogoPath(r)} alt="" className="h-4 w-4 shrink-0 rounded object-contain" />
                            <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{r.model}</span>
                            <span className="shrink-0 text-xs text-[var(--text-muted)]">({r.provider === "zenmux" ? "Zenmux" : r.provider === "dashscope" ? t("customKey.dashscope.short") : r.provider === "mimo" ? "Mimo" : r.provider === "modelscope" ? t("customKey.modelscope.short") : r.provider === "volcengine" ? t("customKey.volcengine.short") : r.provider})</span>
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </section>
              )}

              {/* 4. Voice */}
              <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">{t("customKey.voice.title")}</h3>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{t("customKey.voice.description")}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="minimax-key" className="text-xs">{t("customKey.minimax.keyLabel")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="minimax-key"
                        name="wolfcha-minimax-api-key"
                        type={showMinimaxKey ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder={t("customKey.optionalPlaceholder")}
                        value={minimaxKey}
                        onChange={(e) => setMinimaxKeyState(e.target.value)}
                        className="flex-1"
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => setShowMinimaxKey((v) => !v)} aria-label={showMinimaxKey ? t("customKey.minimax.hide") : t("customKey.minimax.show")}>
                        {showMinimaxKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="minimax-group" className="text-xs">{t("customKey.minimax.groupLabel")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="minimax-group"
                        name="wolfcha-minimax-group-id"
                        type={showMinimaxGroupId ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder={t("customKey.optionalPlaceholder")}
                        value={minimaxGroupId}
                        onChange={(e) => setMinimaxGroupIdState(e.target.value)}
                        className="flex-1"
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => setShowMinimaxGroupId((v) => !v)} aria-label={showMinimaxGroupId ? t("customKey.minimax.hideGroup") : t("customKey.minimax.showGroup")}>
                        {showMinimaxGroupId ? <EyeSlash size={16} /> : <Eye size={16} />}
                      </Button>
                    </div>
                  </div>
                </div>
              </section>

              {/* 5. Actions */}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleClearKeys} className="flex-1">{t("customKey.actions.clear")}</Button>
                <Button type="button" onClick={handleSaveKeys} className="flex-1">{t("customKey.actions.save")}</Button>
              </div>
            </>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
