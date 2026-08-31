import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  AthleteRoutineDetails,
  routineHasDisplayDetails,
} from "../../athlete/AthleteRoutineDetails";
import type { AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import type { DrillLibraryItem } from "../../../lib/drillLibrary";

export function CoachMobileRoutineDetail({
  routine,
  folderName,
  drillById,
  onClose,
}: {
  routine: AuxiliaryRoutine | null;
  folderName: string;
  drillById: Map<string, DrillLibraryItem>;
  onClose: () => void;
}) {
  return (
    <Modal visible={Boolean(routine)} animationType="slide" onRequestClose={onClose}>
      {routine ? (
        <View style={{ flex: 1, backgroundColor: "#f3f6fb" }}>
          <View
            style={{
              borderBottomWidth: 1,
              borderBottomColor: "#dbe2ee",
              backgroundColor: "#fff",
              paddingHorizontal: 12,
              paddingTop: 14,
              paddingBottom: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={2} style={{ fontSize: 18, fontWeight: "900", color: "#172033" }}>
                {routine.title || "Routine"}
              </Text>
              <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, fontWeight: "800", color: "#64748b" }}>
                {folderName}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to routine list"
              onPress={onClose}
              style={{
                minHeight: 40,
                borderWidth: 1,
                borderColor: "#dbe3ef",
                borderRadius: 999,
                paddingHorizontal: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#fff",
              }}
            >
              <Text style={{ color: "#172033", fontWeight: "900" }}>Back</Text>
            </Pressable>
          </View>

          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 12, paddingBottom: 32, gap: 12 }}
          >
            <View
              style={{
                borderWidth: 1,
                borderColor: "#dbe3ef",
                backgroundColor: "#fff",
                borderRadius: 14,
                padding: 12,
                gap: 10,
              }}
            >
              {routineHasDisplayDetails(routine) ? (
                <AthleteRoutineDetails key={routine.id} routine={routine} drillById={drillById} />
              ) : (
                <Text style={{ color: "#64748b", fontWeight: "700", lineHeight: 19 }}>
                  No details have been added to this routine yet.
                </Text>
              )}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </Modal>
  );
}
