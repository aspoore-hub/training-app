import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";

type Props = {
  visible: boolean;
  title: string;
  subtitle?: string;
  planSummary?: string;
  completedMilesText: string;
  completedTimeText: string;
  splitsText: string;
  additionalFeedbackText: string;
  saving: boolean;
  error?: string | null;
  onChangeCompletedMiles: (value: string) => void;
  onChangeCompletedTime: (value: string) => void;
  onChangeSplits: (value: string) => void;
  onChangeAdditionalFeedback: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function AthleteQuickFeedbackSheet({
  visible,
  title,
  subtitle,
  planSummary,
  completedMilesText,
  completedTimeText,
  splitsText,
  additionalFeedbackText,
  saving,
  error,
  onChangeCompletedMiles,
  onChangeCompletedTime,
  onChangeSplits,
  onChangeAdditionalFeedback,
  onCancel,
  onSave,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!saving) onCancel();
      }}
    >
      <View style={{ flex: 1, backgroundColor: "rgba(15, 23, 42, 0.35)", justifyContent: "flex-end" }}>
        <View
          style={{
            maxHeight: "90%",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            backgroundColor: "#ffffff",
            padding: 18,
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
            <View style={{ alignSelf: "center", width: 46, height: 5, borderRadius: 999, backgroundColor: "#cbd5e1", marginBottom: 12 }} />
            <Text style={{ fontSize: 22, fontWeight: "900", color: "#0f172a" }}>{title}</Text>
            {subtitle ? <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>{subtitle}</Text> : null}
            {planSummary ? (
              <View
                style={{
                  marginTop: 12,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "#dbeafe",
                  backgroundColor: "#eff6ff",
                  padding: 12,
                }}
              >
                <Text style={{ fontWeight: "900", color: "#1e3a8a" }}>Planned</Text>
                <Text style={{ marginTop: 4, color: "#1e40af", lineHeight: 20 }}>{planSummary}</Text>
              </View>
            ) : null}

            <View style={{ marginTop: 14, gap: 12 }}>
              <View>
                <Text style={{ fontWeight: "900", color: "#334155" }}>Completed distance</Text>
                <TextInput
                  value={completedMilesText}
                  onChangeText={onChangeCompletedMiles}
                  placeholder="Example: 5.25"
                  keyboardType="decimal-pad"
                  style={{
                    marginTop: 6,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    fontWeight: "800",
                    color: "#0f172a",
                  }}
                />
              </View>
              <View>
                <Text style={{ fontWeight: "900", color: "#334155" }}>Completed time</Text>
                <TextInput
                  value={completedTimeText}
                  onChangeText={onChangeCompletedTime}
                  placeholder="Example: 42:30"
                  style={{
                    marginTop: 6,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    fontWeight: "800",
                    color: "#0f172a",
                  }}
                />
              </View>
              <View>
                <Text style={{ fontWeight: "900", color: "#334155" }}>Splits / pace</Text>
                <TextInput
                  value={splitsText}
                  onChangeText={onChangeSplits}
                  placeholder="Optional"
                  multiline
                  style={{
                    marginTop: 6,
                    minHeight: 72,
                    textAlignVertical: "top",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    fontWeight: "700",
                    color: "#0f172a",
                  }}
                />
              </View>
              <View>
                <Text style={{ fontWeight: "900", color: "#334155" }}>Notes</Text>
                <TextInput
                  value={additionalFeedbackText}
                  onChangeText={onChangeAdditionalFeedback}
                  placeholder="Optional notes"
                  multiline
                  style={{
                    marginTop: 6,
                    minHeight: 92,
                    textAlignVertical: "top",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    fontWeight: "700",
                    color: "#0f172a",
                  }}
                />
              </View>
            </View>

            {error ? <Text style={{ marginTop: 12, color: "#be123c", fontWeight: "800" }}>{error}</Text> : null}

            <View style={{ marginTop: 18, flexDirection: "row", gap: 10 }}>
              <Pressable
                disabled={saving}
                onPress={onCancel}
                style={{
                  flex: 1,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  backgroundColor: "#ffffff",
                  paddingVertical: 13,
                  alignItems: "center",
                  opacity: saving ? 0.65 : 1,
                }}
              >
                <Text style={{ fontWeight: "900", color: "#334155" }}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={saving}
                onPress={onSave}
                style={{
                  flex: 1,
                  borderRadius: 14,
                  backgroundColor: saving ? "#93c5fd" : "#2563eb",
                  paddingVertical: 13,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontWeight: "900", color: "white" }}>{saving ? "Saving..." : "Save log"}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
