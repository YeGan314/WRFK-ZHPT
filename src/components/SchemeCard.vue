<script setup>
import {
  PhArrowRight,
  PhCheckCircle,
  PhClock,
  PhArrowClockwise,
  PhWarningCircle,
  PhLeaf,
} from "@phosphor-icons/vue";
import { format } from "../lib/analysis";
defineProps({
  plan: Object,
  recommended: Boolean,
  selected: Boolean,
  excluded: Boolean,
  busy: Boolean,
});
defineEmits(["retry"]);
</script>
<template>
  <article class="scheme-card" :class="{ recommended, selected, excluded }">
    <div class="scheme-topline">
      <span class="category"><PhLeaf :size="15" />{{ plan.category }}</span
      ><span v-if="recommended" class="recommend-label">优先推荐</span
      ><span v-else-if="selected" class="recommend-label">已选择</span
      ><span v-else class="muted">{{ plan.name }}</span>
    </div>
    <template v-if="['loading', 'queued'].includes(plan.status)"
      ><h3>{{ plan.name }}</h3>
      <p class="muted">{{ plan.caption }}</p>
      <div class="skeleton"></div>
      <div class="skeleton short"></div>
      <div class="loading-line">
        <span v-if="plan.status === 'loading'" class="spinner"></span
        >{{
          plan.status === "queued"
            ? "等待你开始分析"
            : "正在计算措施、效果与投入"
        }}
      </div></template
    >
    <template v-else-if="plan.status === 'error'"
      ><h3>{{ plan.name }}</h3>
      <p class="error-inline"><PhWarningCircle :size="18" />{{ plan.error }}</p>
      <button
        class="text-button"
        :disabled="busy"
        @click="$emit('retry', plan)"
      >
        <PhArrowClockwise :size="16" />重新计算这项
      </button></template
    >
    <template v-else-if="!plan.technologies.length"
      ><h3>{{ plan.name }}</h3>
      <p class="unavailable-plan">本轮未返回可实施措施</p>
      <p class="scheme-facts">不能据此认为无需治理，请结合其他路线继续比较。</p>
      <details class="scheme-details">
        <summary>查看模型说明</summary>
        <p>{{ plan.description || "模型未返回更多说明。" }}</p>
      </details>
      <button class="select-plan secondary" disabled>
        暂无可选方案
      </button></template
    >
    <template v-else>
      <h3>{{ plan.title }}</h3>
      <p class="scheme-caption">
        {{ plan.name }} · {{ plan.technologies.length }} 项措施
      </p>
      <div class="scheme-numbers">
        <div>
          <span>预计每亩投入</span
          ><strong
            >{{ format(plan.cost, 2)
            }}<small v-if="plan.cost !== null"> 元</small></strong
          >
        </div>
        <div v-if="!plan.changesCrop">
          <span>{{ plan.effectLabel }}预测 <small>mg/kg</small></span
          ><strong class="effect-number"
            >{{ format(plan.cdBefore) }}<PhArrowRight :size="17" />{{
              format(plan.cdAfter)
            }}</strong
          >
        </div>
      </div>
      <div
        class="scheme-status"
        :class="plan.meetsTarget === true ? 'positive' : 'neutral'"
      >
        <PhCheckCircle v-if="plan.meetsTarget" :size="17" /><PhLeaf
          v-else
          :size="17"
        />{{
          plan.changesCrop
            ? "涉及改种，需重新确认评价目标"
            : plan.meetsTarget === true
              ? "预计满足本轮稻米指标目标"
              : plan.id === "natural"
                ? "土壤指标预测，与稻米目标分开比较"
                : plan.meetsTarget === false
                  ? "预计尚未达到本轮稻米指标目标"
                  : "数据不足，暂不能判断目标达成"
        }}
      </div>
      <div class="scheme-facts">
        <p><PhClock :size="16" />{{ plan.cycle }}</p>
        <p>{{ plan.constraints }}</p>
      </div>
      <details class="scheme-details">
        <summary>具体怎么做</summary>
        <div v-for="(tech, i) in plan.technologies" :key="i">
          <b>{{ i + 1 }}. {{ tech.name }}</b>
          <p>{{ tech.detail || "模型未返回具体操作" }}</p>
        </div>
        <p>费用为模型按 1 亩计算的投入，人工及维护费用是否包含需核实。</p>
      </details>
      <p v-if="excluded" class="error-inline">
        含品种或作物调整，不符合当前偏好。
      </p>
      <p v-else-if="!plan.canGenerate" class="error-inline">
        实施参数尚不完整，暂不能生成实施方案。
      </p>
    </template>
  </article>
</template>
