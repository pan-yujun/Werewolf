"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CustomCharacter, CustomCharacterInput } from "@/types/custom-character";
import { DEFAULT_CUSTOM_CHARACTER_AGE, DEFAULT_CUSTOM_CHARACTER_GENDER, MAX_CUSTOM_CHARACTERS } from "@/types/custom-character";
import type { User } from "@supabase/supabase-js";
import { fillCustomCharacterOptionalFields } from "@/lib/custom-character-defaults";

const DEV_STORAGE_KEY = "wolfcha_dev_custom_characters";
const IS_DEV_MODE = process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true";

// 开发模式下的 localStorage 操作
function getDevCharacters(): CustomCharacter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CustomCharacter[];
  } catch {
    return [];
  }
}

function saveDevCharacters(characters: CustomCharacter[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(characters));
  } catch {
    // ignore
  }
}

export function useCustomCharacters(user: User | null) {
  const [characters, setCharacters] = useState<CustomCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 开发模式下使用 localStorage
  const isDevMode = IS_DEV_MODE && !user;

  const fetchCharacters = useCallback(async () => {
    if (isDevMode) {
      // 开发模式：从 localStorage 加载
      setCharacters(getDevCharacters());
      setLoading(false);
      return;
    }

    if (!user) {
      setCharacters([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from("custom_characters")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_deleted", false)
        .order("created_at", { ascending: false });

      if (fetchError) throw fetchError;
      setCharacters((data as CustomCharacter[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch characters");
    } finally {
      setLoading(false);
    }
  }, [user, isDevMode]);

  const createCharacter = useCallback(async (input: CustomCharacterInput): Promise<CustomCharacter | null> => {
    if (characters.length >= MAX_CUSTOM_CHARACTERS) {
      setError(`Maximum ${MAX_CUSTOM_CHARACTERS} custom characters allowed`);
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const normalizedInput = fillCustomCharacterOptionalFields(input);
      const avatarSeed = input.avatar_seed || `${input.display_name}-${Date.now()}`;

      if (isDevMode) {
        // 开发模式：保存到 localStorage
        const newChar: CustomCharacter = {
          id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          user_id: "dev-user-local",
          display_name: normalizedInput.display_name.trim(),
          gender: normalizedInput.gender,
          age: normalizedInput.age,
          mbti: normalizedInput.mbti.toUpperCase(),
          basic_info: normalizedInput.basic_info?.trim() || undefined,
          style_label: normalizedInput.style_label?.trim() || undefined,
          avatar_seed: avatarSeed,
          is_deleted: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const updated = [newChar, ...characters];
        saveDevCharacters(updated);
        setCharacters(updated);
        return newChar;
      }

      if (!user) return null;

      const { data, error: insertError } = await supabase
        .from("custom_characters")
        .insert({
          user_id: user.id,
          display_name: normalizedInput.display_name.trim(),
          gender: normalizedInput.gender,
          age: normalizedInput.age,
          mbti: normalizedInput.mbti.toUpperCase(),
          basic_info: normalizedInput.basic_info?.trim() || undefined,
          style_label: normalizedInput.style_label?.trim() || undefined,
          avatar_seed: avatarSeed,
        } as never)
        .select()
        .single();

      if (insertError) throw insertError;

      const newChar = data as CustomCharacter;
      setCharacters(prev => [newChar, ...prev]);
      return newChar;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create character");
      return null;
    } finally {
      setLoading(false);
    }
  }, [user, characters, isDevMode]);

  const updateCharacter = useCallback(async (
    id: string,
    input: Partial<CustomCharacterInput>
  ): Promise<CustomCharacter | null> => {
    setLoading(true);
    setError(null);

    try {
      const shouldNormalizeOptionalFields =
        input.mbti !== undefined || input.basic_info !== undefined || input.style_label !== undefined;
      const normalizedInput = shouldNormalizeOptionalFields
        ? fillCustomCharacterOptionalFields({
            display_name: input.display_name ?? "",
            gender: (input.gender as CustomCharacterInput["gender"]) ?? DEFAULT_CUSTOM_CHARACTER_GENDER,
            age: input.age ?? DEFAULT_CUSTOM_CHARACTER_AGE,
            mbti: input.mbti ?? "",
            basic_info: input.basic_info ?? "",
            style_label: input.style_label ?? "",
            avatar_seed: input.avatar_seed,
          })
        : null;

      if (isDevMode) {
        // 开发模式：更新 localStorage
        const existing = characters.find(c => c.id === id);
        if (!existing) throw new Error("Character not found");

        const updated: CustomCharacter = {
          ...existing,
          display_name: input.display_name?.trim() ?? existing.display_name,
          gender: input.gender ?? existing.gender,
          age: input.age ?? existing.age,
          mbti: (normalizedInput?.mbti ?? input.mbti ?? existing.mbti).toUpperCase(),
          basic_info: normalizedInput?.basic_info?.trim() || input.basic_info?.trim() || existing.basic_info,
          style_label: normalizedInput?.style_label?.trim() || input.style_label?.trim() || existing.style_label,
          avatar_seed: input.avatar_seed ?? existing.avatar_seed,
          updated_at: new Date().toISOString(),
        };

        const updatedList = characters.map(c => c.id === id ? updated : c);
        saveDevCharacters(updatedList);
        setCharacters(updatedList);
        return updated;
      }

      if (!user) return null;

      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (input.display_name !== undefined) updateData.display_name = input.display_name.trim();
      if (input.gender !== undefined) updateData.gender = input.gender;
      if (input.age !== undefined) updateData.age = input.age;
      if (input.mbti !== undefined) updateData.mbti = (normalizedInput?.mbti ?? input.mbti).toUpperCase();
      if (input.basic_info !== undefined) updateData.basic_info = normalizedInput?.basic_info?.trim() || null;
      if (input.style_label !== undefined) updateData.style_label = normalizedInput?.style_label?.trim() || null;
      if (input.avatar_seed !== undefined) updateData.avatar_seed = input.avatar_seed;

      const { data, error: updateError } = await supabase
        .from("custom_characters")
        .update(updateData as never)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single();

      if (updateError) throw updateError;

      const updated = data as CustomCharacter;
      setCharacters(prev => prev.map(c => c.id === id ? updated : c));
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update character");
      return null;
    } finally {
      setLoading(false);
    }
  }, [user, characters, isDevMode]);

  const deleteCharacter = useCallback(async (id: string): Promise<boolean> => {
    setLoading(true);
    setError(null);

    try {
      if (isDevMode) {
        // 开发模式：从 localStorage 删除
        const updated = characters.filter(c => c.id !== id);
        saveDevCharacters(updated);
        setCharacters(updated);
        return true;
      }

      if (!user) return false;

      const { error: deleteError } = await supabase
        .from("custom_characters")
        .update({ is_deleted: true, updated_at: new Date().toISOString() } as never)
        .eq("id", id)
        .eq("user_id", user.id);

      if (deleteError) throw deleteError;

      setCharacters(prev => prev.filter(c => c.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete character");
      return false;
    } finally {
      setLoading(false);
    }
  }, [user, characters, isDevMode]);

  useEffect(() => {
    void fetchCharacters();
  }, [fetchCharacters]);

  return {
    characters,
    loading,
    error,
    fetchCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    canAddMore: characters.length < MAX_CUSTOM_CHARACTERS,
    remainingSlots: MAX_CUSTOM_CHARACTERS - characters.length,
  };
}
