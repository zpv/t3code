import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { QRCodeSvg } from "~/components/ui/qr-code";
import { toastManager } from "~/components/ui/toast";
export function QrDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Open on phone</DialogTitle>
          <DialogDescription>Scan this code with your phone.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col items-center gap-4">
            <QRCodeSvg value={url} size={220} marginSize={4} title="QR code" />
            <p className="max-w-full text-center text-sm break-all text-muted-foreground">{url}</p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => toastManager.add({ type: "success", title: "Link copied" }))
            }
          >
            Copy link
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
