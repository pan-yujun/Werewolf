"use client";

import Image from "next/image";
import type { PlayerReview, EnrichmentState, EnrichmentType } from "@/types/analysis";
import { ROLE_ICONS, ROLE_NAMES } from "./constants";
import { buildSimpleAvatarUrl } from "@/lib/avatar-config";
import { AnalysisButton } from "./AnalysisButton";

interface PlayerReviewsProps {
  reviews: PlayerReview[];
  onSelectPlayer?: (playerId: string) => void;
  enrichmentState?: EnrichmentState;
  onEnrich?: (type: EnrichmentType) => void;
}

function ReviewCard({ review, onClick }: { review: PlayerReview; onClick?: () => void }) {
  const isAlly = review.relation === "ally";

  return (
    <button
      type="button"
      onClick={onClick}
      className="analysis-card p-5 rounded-xl relative group w-full text-left cursor-pointer hover:bg-white/5 transition-colors overflow-hidden"
    >
      <div
        className={`absolute top-0 left-0 px-3 py-1 border-r border-b rounded-br-lg text-[10px] font-bold tracking-wider ${
          isAlly
            ? "bg-[#2f855a]/20 border-[#2f855a]/30 text-[#2f855a]"
            : "bg-[#c53030]/20 border-[#c53030]/30 text-[#c53030]"
        }`}
      >
        {isAlly ? "队友" : "对手"}
      </div>

      <div className="flex items-center gap-3 mb-4 mt-2">
        <div className="w-10 h-10 rounded-full border border-[var(--color-gold)]/20 p-0.5 bg-black/20">
          <img
            src={buildSimpleAvatarUrl(review.avatar)}
            alt={review.fromCharacterName}
            className="w-full h-full rounded-full grayscale group-hover:grayscale-0 transition-all"
          />
        </div>
        <div>
          <div className="text-sm font-bold text-[var(--text-primary)]">
            {review.fromCharacterName}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Image
              src={ROLE_ICONS[review.role]}
              alt={ROLE_NAMES[review.role]}
              width={12}
              height={12}
              className="opacity-70"
            />
            <span className="text-[10px] text-[var(--text-muted)]">
              {ROLE_NAMES[review.role]}
            </span>
          </div>
        </div>
      </div>

      <p className="text-xs text-[var(--text-secondary)] leading-relaxed italic border-l-2 border-[var(--color-gold)]/20 pl-3">
        &ldquo;{review.content}&rdquo;
      </p>
    </button>
  );
}

export function PlayerReviews({ reviews, onSelectPlayer, enrichmentState, onEnrich }: PlayerReviewsProps) {
  const reviewsLoaded = enrichmentState?.reviews?.loaded ?? true;

  return (
    <section>
      <h3 className="text-center font-bold text-[var(--color-gold)]/40 text-xs mb-6 tracking-[0.3em] analysis-ornament-border pb-3">
        选手评价
      </h3>

      {!reviewsLoaded ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-xs text-[var(--text-muted)]">AI 可以为你生成选手评价</p>
          {onEnrich && (
            <AnalysisButton
              label="AI 分析评价"
              loading={enrichmentState?.reviews?.loading}
              error={enrichmentState?.reviews?.error}
              onClick={() => onEnrich("reviews")}
            />
          )}
        </div>
      ) : reviews.length > 0 ? (
        <div className="flex flex-col gap-4">
          {reviews.map((review, idx) => (
            <ReviewCard
              key={idx}
              review={review}
              onClick={() => onSelectPlayer?.(review.fromPlayerId)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
